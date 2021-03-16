const { UserAgentService } = require('./services/useragent');
const { WebServerService } = require('./services/webserver');
const { JwtService } = require('./services/jwt');
const { SamlBearerService } = require('./services/samlbearer');
const { UsernamePasswordService } = require('./services/usernamepassword');
const { DeviceService } = require('./services/device');

// Load dependencies
var express = require('express'),
    request = require('request'),
    bodyParser = require('body-parser'),
    morgan = require('morgan'),
    app = express(),
    path = require('path'),
    https = require('https'),
    fs = require('fs'),
    base64url = require('base64-url'),
    nJwt = require('njwt'),
    saml = require('saml').Saml20,
    CryptoJS = require('crypto-js'),
    crypto = require('crypto');

// Set global variables, some loaded from environment variables (.env file)
var apiVersion = 'v45.0',
    clientId = process.env.CLIENT_ID,
    clientSecret = process.env.CLIENT_SECRET,
    callbackURL = process.env.CALLBACK_URL,
    baseURL = process.env.BASE_URL,
    username = process.env.USERNAME,
    persistTokensToFile = process.env.PERSIST === 'true',
    isSandbox = false,
    state = '',
    refreshToken = '',
    webserverType = '',
    authInstance,
    userAgentInstance,
    webServerInstance;

// Set default view engine to ejs. This will be used when calling res.render().
app.set('view engine', 'ejs');

// Let Express know where the client files are located
app.use(express.static(__dirname + '/client'));

// Setting up of app
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Set the port to use based on the environment variables
app.set('port', process.env.PORT);

/**
 * Extract Access token from POST response and redirect to page queryresult.
 * @param {*} err Error object returned to the callback function in case anything went wrong.
 * @param {*} remoteResponse The response code from the remote call.
 * @param {String} remoteBody The (JSON) body response from the remote call.
 * @param {*} res The resource from Express, modify to display a result.
 */
function accessTokenCallback(err, remoteResponse, remoteBody, res) {
    // Display error if error is returned to callback function
    if (err) {
        return res.status(500).end('Error');
    }

    // Retrieve the response and store in JSON object
    let sfdcResponse = JSON.parse(remoteBody);

    let identityUrl = sfdcResponse.id;
    let issuedAt = sfdcResponse.issued_at;
    let idToken = sfdcResponse.id_token;
    let accessToken = sfdcResponse.access_token;

    // If identity URL is specified, check its signature based on identity URL and 'issued at'
    if (identityUrl && issuedAt) {
        // Create SHA-256 hash of identity URL and 'issued at' based on client secret
        let hash = CryptoJS.HmacSHA256(identityUrl + issuedAt, clientSecret);
        let hashInBase64 = CryptoJS.enc.Base64.stringify(hash);

        // Show error if base64 encoded hash doesn't match with the signature in the response
        if (hashInBase64 != sfdcResponse.signature) {
            return res.status(500).end('Signature not correct - Identity cannot be confirmed');
        }
    }

    // If ID Token is specified, parse it and print it in the console
    if (idToken) {
        // Decode ID token
        let tokenSplit = idToken.split('.');
        let header = CryptoJS.enc.Base64.parse(tokenSplit[0]);
        let body = CryptoJS.enc.Base64.parse(tokenSplit[1]);

        console.log('ID Token header: ' + header.toString(CryptoJS.enc.Utf8));
        console.log('ID Token body: ' + body.toString(CryptoJS.enc.Utf8));
    }

    // In case no error and signature checks out, AND there is an access token present, store refresh token in global state and redirect to query page
    if (accessToken) {
        if (sfdcResponse.refresh_token) {
            refreshToken = sfdcResponse.refresh_token;
        }

        res.writeHead(302, {
            Location: 'queryresult',
            'Set-Cookie': [
                'AccToken=' + accessToken,
                'APIVer=' + apiVersion,
                'InstURL=' + sfdcResponse.instance_url,
                'idURL=' + sfdcResponse.id,
            ],
        });
    } else {
        res.write(
            'Some error occurred. Make sure connected app is approved previously if its JWT flow, Username and Password is correct if its Password flow. '
        );
        res.write(' Salesforce Response : ');
        res.write(remoteBody);
    }
    res.end();
}

/**
 * Extract Access token from POST response and redirect to page queryresult.
 * @param {boolean} success True if successful result returned, false otherwise.
 * @param {String} header JSON string containing header information for the response page.
 * @param {String} response Either the content of an error message, or the refresh token in case of success.
 */
function processResponse(error, accessTokenHeader, refreshToken, redirect, res) {
    if (redirect) {
        // Page needs to be rerendered to retry retrieving access token (device flow)
        console.log(
            'Rendering the following page: ' + redirect.location + '.\nPayload: ' + JSON.stringify(redirect.payload)
        );
        res.render(redirect.location, redirect.payload);
    } else if (error) {
        // If response doesn't return a successful response, show the error page.
        console.log('No successful response from request. Showing error page with error: ' + response);
        res.status(500).end(response);
    } else {
        // If response returns successful response, we set the access token in the cookies and store the refresh token
        console.log(
            'Setting cookies: ' +
                JSON.stringify(accessTokenHeader) +
                '. Storing following refresh token: ' +
                refreshToken
        );
        this.refreshToken = refreshToken;
        res.writeHead(302, accessTokenHeader);
        res.end();
    }
}

/**
 * Extract Access token from POST response and redirect to page queryresult.
 * @param {*} err Error object returned to the callback function in case anything went wrong.
 * @param {*} remoteResponse The response code from the remote call.
 * @param {String} remoteBody The (JSON) body response from the remote call.
 * @param {*} res The resource from Express, modify to display a result.
 */
function deviceFlowCallback(err, remoteResponse, remoteBody, res) {
    // If an error is received, show it
    if (err) {
        return res.status(500).end('Error:' + err);
    }

    // Parse the response for the device flow, either a user code to be displayed or the access token
    let sfdcResponse = JSON.parse(remoteBody);
    let verificationUri = sfdcResponse.verification_uri;
    let userCode = sfdcResponse.user_code;
    let deviceCode = sfdcResponse.device_code;
    let interval = sfdcResponse.interval;
    let accessToken = sfdcResponse.access_token;

    // Render query result if access token is present, or show user code page if not
    if (accessToken) {
        res.writeHead(302, {
            Location: 'queryresult',
            'Set-Cookie': [
                'AccToken=' + sfdcResponse.access_token,
                'APIVer=' + apiVersion,
                'InstURL=' + sfdcResponse.instance_url,
                'idURL=' + sfdcResponse.id,
            ],
        });
        res.end();
    } else if (verificationUri) {
        res.render('deviceOAuth', {
            verification_uri: verificationUri,
            user_code: userCode,
            device_code: deviceCode,
            isSandbox: isSandbox,
            interval: interval,
        });
    }
}

/**
 * Function that generates a cryptographically random code verifier
 * @returns Cryptographically random code verifier
 */
function generateCodeVerifier() {
    return crypto.randomBytes(128).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Function that hashes the code verifier and encodes it into base64URL
 * @param {String} verifier The code verifier string. This string should be long enough to be secure.
 * @returns Code challenge based on provided verifier
 */
function generateCodeChallenge(verifier) {
    return CryptoJS.SHA256(verifier)
        .toString(CryptoJS.enc.Base64)
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

/**
 * Set whether this flow is being executed for a sandbox or not.
 * @param {String} sandboxString The string containing 'true' or 'false' on whether or not
 * we're in the sandbox flow.
 */
function setSandbox(sandboxString) {
    isSandbox = sandboxString === 'true';
}

/**
 * Return the base URL for sending any HTTP requests to
 */
function getBaseUrl() {
    return isSandbox ? 'https://test.salesforce.com/' : baseURL;
}

/**
 * Return the Token Endpoint for the set base URL
 * @returns The token endpoint URL
 */
function getTokenEndpoint() {
    return getBaseUrl() + '/services/oauth2/token';
}

/**
 * Creates a HTTP POST request JSON object that can be passed along to the Express "request".
 * @param {String} endpointUrl The url of the endpoint (authorization or token).
 * @param {String} body The parameters to be passed to the endpoint as URL parameters (key1=value1&key2=value2&...).
 * @returns JSON object containing information needed for sending the POST request.
 */
function createPostRequest(endpointUrl, body) {
    return {
        method: 'POST',
        url: endpointUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body,
    };
}

function handleGetRequest(getRequest, res) {
    request({ method: 'GET', url: getRequest }).pipe(res);
}

function handlePostRequest(postRequest, res) {
    request(postRequest, function (error, remoteResponse, remoteBody) {
        // Handle error or process response
        if (error) {
            res.status(500).end('Error occurred: ' + JSON.stringify(error));
        } else {
            let { error, accessTokenHeader, refreshToken, redirect } = authInstance.processCallback(remoteBody);
            processResponse(error, accessTokenHeader, refreshToken, redirect, res);
        }
    });
}

app.all('/proxy', function (req, res) {
    var url = req.header('SalesforceProxy-Endpoint');
    request({
        url: url,
        method: req.method,
        json: req.body,
        headers: {
            Authorization: req.header('X-Authorization'),
            'Content-Type': 'application/json',
        },
        body: req.body,
    }).pipe(res);
});

/**
 *	User Agent oAuth Flow. Gets launched when navigating to '/uAgent'.
 *  Depending on the 'isSandbox' parameter in the URL, the production or sandbox flow is triggered.
 */
app.get('/uAgent', function (req, res) {
    // Instantiate the service to create the URL to call
    authInstance = new UserAgentService(req.query.isSandbox);
    const userAgentUrlWithParameters = authInstance.generateUserAgentRequest();

    // Launch the HTTP GET request based on the constructed URL with parameters
    handleGetRequest(userAgentUrlWithParameters, res);
});

/**
 *  Step 1 Web Server Flow - Get Code. Gets launched when navigating to '/webServer'.
 *  Depending on the 'isSandbox' parameter in the URL, the production or sandbox flow is triggered.
 *  This is the first step in the flow, where the authorization code is retrieved from the authorization endpoint.
 */
app.get('/webServer', function (req, res) {
    // Instantiate the service to create the URL to call
    authInstance = new WebServerService(req.query.isSandbox, req.query.type);
    const authorizationUrl = authInstance.generateAuthorizationRequest();

    // Launch the request to get the authorization code
    handleGetRequest(authorizationUrl, res);
});

/**
 * Step 2 Web Server Flow - Get access token using authorization code.
 * Gets launched as part of the callback actions from the first step of the web server flow.
 * This is the second step in the flow where the access token is retrieved by passing the previously
 * obtained authorization code to the token endpoint.
 */
app.get('/webServerStep2', function (req, res) {
    // Web Server instance was already created during first step of the flow, just send the request
    let postRequest = authInstance.generateTokenRequest(req.query.code);

    // Send the request to the endpoint and specify callback function
    handlePostRequest(postRequest, res);
});

/**
 * JWT Bearer Assertion Flow. Gets launched when navigating to '/jwt'.
 * Depending on the 'isSandbox' parameter in the URL, the production or sandbox flow is triggered.
 * Creates a JWT token for the username defined in the environment variables, then posts it to the token endpoint.
 */
app.get('/jwt', function (req, res) {
    // Instantiate JWT service and generate post request
    authInstance = new JwtService(req.query.isSandbox);
    let postRequest = authInstance.generateJwtRequest();

    // Handle the response of the post request
    handlePostRequest(postRequest, res);
});

/**
 * SAML Bearer Assertion Flow. Gets launched when navigating to '/samlBearer'.
 * Depending on the 'isSandbox' parameter in the URL, the production or sandbox flow is triggered.
 * Creates a SAML bearer token for the username defined in the environment variables, then posts it to the token endpoint.
 */
app.get('/samlBearer', function (req, res) {
    // Instantiate SAML Bearer service and generate post request
    authInstance = new SamlBearerService(req.query.isSandbox);
    let postRequest = authInstance.generateSamlBearerRequest();

    // Handle the response of the post request
    handlePostRequest(postRequest, res);
});

/**
 * Username Password oAuth Flow. Gets launched when navigating to '/uPwd'.
 * Depending on the 'isSandbox' parameter in the URL, the production or sandbox flow is triggered.
 * Sends username and password in the URL as free text to the token endpoint.
 */
app.post('/uPwd', function (req, res) {
    // Instantiate Username-Password service and generate post request
    authInstance = new UsernamePasswordService(req.query.isSandbox);
    let postRequest = authInstance.generateUsernamePasswordRequest(req.body.sfdcUsername, req.body.sfdcPassword);

    // Handle the response of the post request
    handlePostRequest(postRequest, res);
});

/**
 * Device Authentication Flow. Gets launched when navigating to '/device'.
 * Depending on the 'isSandbox' parameter in the URL, the production or sandbox flow is triggered.
 * Retrieves a device code, user code and verification URI and displays it to the user.
 */
app.get('/device', function (req, res) {
    // Instantiate Device service and generate post request
    authInstance = new DeviceService(req.query.isSandbox);
    let postRequest = authInstance.generateDeviceRequest();

    // Handle the response of the post request
    console.log('Sending request to get device code...');
    handlePostRequest(postRequest, res);
});

/**
 * This method is called every time we poll the token endpoint to see if the device
 * was authorized. It only loads the page in case a response was received
 */
app.get('/devicePol', function (req, res) {
    console.log('Starting polling for authorization...');
    // Asynchrous polling of the endpoint using a promise. Set device response on success.
    authInstance.pollContinually().then((response) => {
        console.log('Authorization granted by user.');
        processResponse(response.error, response.accessTokenHeader, response.refreshToken, response.redirect, res);
    });
});

/**
 * Refresh Token Flow. Gets launched when navigating to '/refresh'.
 * Depending on the 'isSandbox' parameter in the URL, the production or sandbox flow is triggered.
 * Requires another flow to be run that provided a refresh token, previous to launching this flow.
 * Sends the refresh token to the token endpoint.
 */
app.get('/refresh', function (req, res) {
    // Set sandbox context
    setSandbox(req.query.isSandbox);

    // Set parameters for POST request
    const grantType = 'refresh_token';
    let endpointUrl = getTokenEndpoint();
    let paramBody =
        'grant_type=' + base64url.escape(grantType) + '&refresh_token=' + this.refreshToken + '&client_id=' + clientId;

    // Create the POST request
    let postRequest = createPostRequest(endpointUrl, paramBody);

    // Launch POST request towards token endpoint
    request(postRequest, function (err, remoteResponse, remoteBody) {
        accessTokenCallback(err, remoteResponse, remoteBody, res);
    });
});

/**
 * SAML assertion flow using Axiom SSO. Gets launched when navigating to '/samlAssert'.
 * Depending on the 'isSandbox' parameter in the URL, the production or sandbox flow is triggered.
 * Requires a SAML assertion that is stored on the server's file system ('data/axiomSamlAssertino.xml').
 */
app.get('/samlAssert', function (req, res) {
    // Set sandbox context
    setSandbox(req.query.isSandbox);

    // Set parameters for the SAML request body
    const assertionType = 'urn:oasis:names:tc:SAML:2.0:profiles:SSO:browser';
    let endpointUrl = getTokenEndpoint();

    // Read assertion XML from file located at 'data/axiomSamlAssertion.xml'. Alternatively, copy-paste XML string below and assign to variable.
    let assertionXml = fs.readFileSync('data/axiomSamlAssertion.xml', 'utf8');
    let base64AssertionXml = Buffer.from(assertionXml).toString('base64');

    // Construct the request body containing grant type, assertion type and assertion. All should be URL encoded.
    let samlParamBody =
        'grant_type=' +
        encodeURIComponent('assertion') +
        '&assertion_type=' +
        encodeURIComponent(assertionType) +
        '&assertion=' +
        encodeURIComponent(base64AssertionXml);

    let postRequest = createPostRequest(endpointUrl, samlParamBody);

    // Launch the POST request with the constructured body to the defined endpoint.
    request(postRequest, function (err, remoteResponse, remoteBody) {
        accessTokenCallback(err, remoteResponse, remoteBody, res);
    });
});

/**
 * Display the home page.
 */
app.route(/^\/(index.*)?$/).get(function (req, res) {
    res.render('index', {
        callbackURL: callbackURL,
        baseURL: baseURL,
        username: username,
        clientId: clientId,
        clientSecret: clientSecret,
        codeVerifier: codeVerifier,
        codeChallenge: codeChallenge,
    });
});

/**
 * Handle OAuth callback from Salesforce and parse the result.
 * Result is parsed in oauthcallback.ejs.
 */
app.get('/oauthcallback', function (req, res) {
    let code = req.query.code;
    let returnedState = req.query.state;
    let originalState = authInstance ? authInstance.state : undefined;

    res.render('oauthcallback', {
        code: code,
        returnedState: returnedState,
        originalState: originalState,
    });
});

/**
 * Use the access token to execute a query using Salesforce REST API.
 * Access token is stored in session cookies, so no need to pass it on.
 */
app.get('/queryresult', function (req, res) {
    res.render('queryresult');
});

/**
 * Log message to indicate on which port the application is running.
 */
app.listen(app.get('port'), function () {
    console.log('Express server listening on port ' + app.get('port'));
});

// Load files with private key and corresponding public certificate
var options = {
    key: fs.readFileSync('./key.pem', 'utf8'),
    cert: fs.readFileSync('./server.crt', 'utf8'),
};

// // Define code verifier and code challenge
var codeVerifier = generateCodeVerifier();
var codeChallenge = generateCodeChallenge(codeVerifier);

// Create the server and log that it's up and running
https.createServer(options, app).listen(8081);
console.log('Server listening for HTTPS connections on port ', 8081);

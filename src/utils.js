const Apify = require('apify');
const { log } = Apify.utils;

const { PROXY_DEFAULT_COUNTRY } = require('./constants');

function validateInput(input) {
    if (!input) throw new Error('INPUT is missing.');
    // defaults
    if (!input.mode) input.mode = 'upload';

    // check required field
    if (!input.username && !input.password)
        throw new Error('INPUT must have "username" and "password" properties.');
    if (!input.spreadsheetId && !input.information)
        throw new Error('INPUT must have "spreadsheetId" or "information" properties.');
    if (input.mode !== 'login' && input.mode !== 'upload')
        throw new Error('INPUT "mode" can only be set to "login" or "upload".');

    // validate function
    const validate = (inputKey, type = 'string') => {
        const value = input[inputKey];

        if (type === 'array') {
            if (!Array.isArray(value)) {
                throw new Error(`Value of ${inputKey} should be array`);
            }
        } else if (value) {
            if (typeof value !== type) {
                throw new Error(`Value of ${inputKey} should be ${type}`);
            }
        }
    };

    // check correct types
    validate('username', 'string');
    validate('password', 'string');
    validate('mode', 'string');
    // understand spreadsheetId || information
    validate('spreadsheetId', 'string');
    validate('information', 'object'); // serializable ??? json ???
    validate('proxyConfiguration', 'object');
}

function getProxyUrl(proxyConfiguration, addSession) {
    let { useApifyProxy = true, proxyUrl, apifyProxyGroups } = proxyConfiguration;
    // console.log(useApifyProxy, proxyUrl, apifyProxyGroups);

    // if no custom proxy is provided, set proxyUrl
    if (!proxyUrl) {
        if (!useApifyProxy) return undefined;

        proxyUrl = Apify.getApifyProxyUrl({
            password: process.env.APIFY_PROXY_PASSWORD,
            groups: apifyProxyGroups,
            session: addSession ? Date.now().toString() : undefined,
            country: PROXY_DEFAULT_COUNTRY
        });
    }

    return proxyUrl;
}

// function checkAndEval(extendOutputFunction) {
//     let evaledFunc;
//
//     try {
//         evaledFunc = eval(extendOutputFunction);
//     } catch (e) {
//         throw new Error(`extendOutputFunction is not a valid JavaScript! Error: ${e}`);
//     }
//
//     if (typeof evaledFunc !== 'function') {
//         throw new Error('extendOutputFunction is not a function! Please fix it or use just default output!');
//     }
//
//     return evaledFunc;
// }
//
// async function applyFunction($, evaledFunc, item) {
//     const isObject = val => typeof val === 'object' && val !== null && !Array.isArray(val);
//
//     let userResult = {};
//     try {
//         userResult = await evaledFunc($);
//     } catch (err) {
//         log.error(`extendOutputFunction crashed! Pushing default output. Please fix your function if you want to update the output. Error: ${err}`);
//     }
//
//     if (!isObject(userResult)) {
//         log.exception(new Error('extendOutputFunction must return an object!'));
//         process.exit(1);
//     }
//
//     return { ...item, ...userResult };
// }

module.exports = {
    validateInput,
    getProxyUrl,
    // checkAndCreateUrlSource,
    // maxItemsCheck,
    // checkAndEval,
    // applyFunction,
};

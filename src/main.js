const Apify = require('apify');
const { log, sleep, requestAsBrowser } = Apify.utils;
const dns = require('dns');
const dnsPromises = dns.promises;
const querystring = require('querystring');

const anticaptcha = require('./anticaptcha')('76dbbc3a8a13f1b092d2104398379f8c');

const { LOGIN_URL, START_URL, BASE_ITEM_URL, COOKIES } = require('./constants');

const {
    validateInput,
    getProxyUrl,
} = require('./utils');

/*
    NOTES FOR DOCUMENTATION:
    before running the actor, you must have already agreed the ebay 'supplementary user agreement'
    and given confirmation for a payment account needed for sale fees, rembursement etc. (This is usually done and saved after submitting your first product for sale)
    IF NOT, please add a product for sale manually and after submitting you will be asked for this two things to do. After that, the actor can run automatically
*/

//

Apify.main(async () => {
    const input = await Apify.getInput();
    validateInput(input);

    const {
        username,
        password,
        mode,
        spreadsheetId,
        information,
        proxyConfiguration,
    } = input;

    // create proxy url and userAgent to be used in crawler configuration
    const proxyUrl = getProxyUrl(proxyConfiguration, true);
    if (!proxyUrl) log.warning('No proxy is configured');
    const userAgent = proxyUrl ? Apify.utils.getRandomUserAgent() : undefined;

    // initialize request list from url sources
    const sources = mode === 'upload'
        ? [{ url: START_URL, userData: { label: 'START' } }]
        : [{ url: LOGIN_URL, userData: { label: 'LOGIN' } }];
    const requestList = await Apify.openRequestList('start-list', sources);

    // open request queue
    const requestQueue = await Apify.openRequestQueue();

    // open dataset and get itemCount
    const dataset = await Apify.openDataset();

    // crawler config
    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        maxRequestRetries: 3,
        handlePageTimeoutSecs: 300,
        maxConcurrency: 10,
        launchPuppeteerOptions: {
            // useApifyProxy: true,
            proxyUrl: proxyUrl,
            // apifyProxyGroups: ['RESIDENTIAL'],
            // userAgent: userAgent,
            // useSessionPool: true,
            timeout: 120 * 1000,
            // useChrome: true,
            // stealth: true,
            headless: false,
            // devtools: true
        },

        gotoFunction: async ({ request, page }) => {
            // await Apify.utils.puppeteer.blockRequests(page);

            if (mode === 'upload') {
                await page.setCookie(...COOKIES);
            }

            return page.goto(request.url, {
                timeout: 180 * 1000,
                waitUntil: 'load'
            });
        },

        handlePageFunction: async ({ page, request, response }) => {
            log.info('Processing:', request.url);
            const { label } = request.userData;

            //

            if (label === 'LOGIN') {
                let getChallengeUrl;
                await page.setRequestInterception(true);
                page.on('request', request => {
                    if (request.url().includes('https://api-na.geetest.com/get.php?')) {
                        getChallengeUrl = request.url();
                        console.log('getChallengeUrl:', getChallengeUrl);
                        request.abort();
                    }
                    else {
                        request.continue();
                    }

                });

                log.info(`
                    Login mode.
                    Actor will login and save cookies in your KV store.
                    Once done, run the actor in "upload" mode.
                `);

                // check if captcha is on screen
                try {
                    await page.waitForSelector('div.geetest_radar_tip', { timeout: 15*1000 });
                } catch (err) {
                    console.log('no recaptcha now. keep going.');
                }

                // check if login inputs are on screen
                const isCredInput = await page.evaluate(() => !!document.getElementById('userid'));

                if (isCredInput) {
                    // log in
                    await page.waitForSelector('#userid');
                    await page.waitForSelector('#pass');

                    await page.type('#userid', username, { delay: 100 });
                    await page.type('#pass', password, { delay: 100 });
                    const [ response ] = await Promise.all([
                        page.waitForNavigation({ waitUntil: 'load', timeout: 60*1000 }),
                        page.click('#sgnBt')
                    ]);

                    await page.waitForSelector('div.geetest_radar_tip', { timeout: 15*1000 });
                }

                // get querystring from getChallengeUrl
                const qstring = getChallengeUrl.split('?')[1];
                // grab codes needed for solving captcha (gt, challenge)
                const { gt, challenge } = querystring.parse(qstring);
                console.log('tokens:', gt, challenge);

                // await page.waitForNavigation({ timeout: 360*1000 });
                // return;

                let currentLocation = await page.evaluate(() => window.location.href);
                console.log('currentLocation', currentLocation);

                // set anticaptcha
                anticaptcha.setWebsiteURL(currentLocation); //.split('?')[0]
                anticaptcha.setWebsiteKey(gt);
                anticaptcha.setWebsiteChallenge(challenge);
                anticaptcha.setGeetestApiServerSubdomain('api-na.geetest.com');
                anticaptcha.setUserAgent(userAgent);

                //grab and set proxy access parameters
                const proxyAddress = proxyUrl.split('@')[1].split(':')[0];
                const proxyPort = proxyUrl.split('@')[1].split(':')[1].split('/')[0];
                const proxyLogin = proxyUrl.split('@')[0].split(':')[1].replace('//', '');
                const proxyPass = proxyUrl.split('@')[0].split(':')[2];

                const dnsRes = await dnsPromises.lookup(proxyAddress);
                const proxyIP = dnsRes.address;
                console.log('proxyIP', proxyIP);

                anticaptcha.setProxyType("http");
                anticaptcha.setProxyAddress(proxyIP);
                anticaptcha.setProxyPort(proxyPort);
                anticaptcha.setProxyLogin(proxyLogin);
                anticaptcha.setProxyPassword(proxyPass);

                // check balance first
                // get task solution and POST it
                anticaptcha.getBalance(function (err, balance) {
                    if (err) {
                        console.error(err);
                        return;
                    }

                    if (balance > 0) {
                        anticaptcha.createGeeTestTask(function (err, taskId) {
                            if (err) {
                                console.error(err);
                                return;
                            }

                            console.log(taskId);

                            anticaptcha.getTaskSolution(taskId, async function (err, taskSolution) {
                                if (err) {
                                    console.error(err);
                                    return;
                                }

                                // got solution
                                console.log('taskSolution:', taskSolution);

                                //

                                // grab POST url (for posting solution to ebay)
                                const { url, dCF_ticket } = await page.evaluate(() => {
                                    const url = document.querySelector('#distilCaptchaForm').action;
                                    const dCF_ticket = document.querySelector('input#dCF_ticket').value;

                                    return { url, dCF_ticket };
                                });

                                // div.geetest_form and input#dCF_input_complete are not available in the html (I think because I aborted the request (at line 101) and captcha div remains on 'loading')
                                // so I try to replicate the POST request
                                const resx = await requestAsBrowser({
                                    url,
                                    method: 'POST',
                                    headers: {
                                        'x-distil-ajax': '', // ?
                                        'content-type': 'application/x-www-form-urlencoded'
                                    },
                                    payload: encodeURIComponent(`dCF_ticket=${dCF_ticket}&geetest_challenge=${taskSolution.challenge}&geetest_validate=${taskSolution.validate}&geetest_seccode=${taskSolution.seccode}&isAjax=1`)
                                });

                                console.log('resx', resx);
                            });
                        });
                    }
                });

                console.log('END');
                await page.waitForNavigation({ timeout: 360*1000 });
                console.log('END2');
            }







            //

            if (label === 'START') {
                // get the right frame
                const availableFrames = page.mainFrame().childFrames();
                let frame;
                for (const item of availableFrames) {
                    if (item._name === 'findprod_iframe') frame = item;
                }

                // select category step 1
                await frame.evaluate(() => {
                    const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
                    const getElementsByIncludedText = (str, tag, rootElement = document) => {
                        return Array.prototype.slice.call(rootElement.getElementsByTagName(tag)).filter(el => el.textContent.trim().includes(str.trim()));
                    }

                    const browseCatButton = document.querySelector('button[block="browse-categories"]');
                    browseCatButton.click();
                    // await sleep(200);
                    // sleep? seems not needed

                    const ulCat1 = document.getElementById('caty_1');
                    const liCat1 = getElementsByIncludedText('Musical Instruments & Gear', 'li', ulCat1)[0];
                    // click li of cat1, it makes appear cat2 box
                    liCat1.click();
                });

                // select category step 2
                await frame.waitForSelector('#caty_2');
                await frame.evaluate(() => {
                    const getElementsByIncludedText = (str, tag, rootElement = document) => {
                        return Array.prototype.slice.call(rootElement.getElementsByTagName(tag)).filter(el => el.textContent.trim().includes(str.trim()));
                    }

                    const ulCat2 = document.getElementById('caty_2');
                    const liCat2 = getElementsByIncludedText('Guitars & Basses', 'li', ulCat2)[0];
                    liCat2.click();
                });

                // select category step 3, and wait for navigation after clicking
                await frame.waitForSelector('#caty_3');
                const [ response ] = await Promise.all([
                    page.waitForNavigation({ timeout: 60*1000 }),
                    await frame.evaluate(() => {
                        const getElementsByIncludedText = (str, tag, rootElement = document) => {
                            return Array.prototype.slice.call(rootElement.getElementsByTagName(tag)).filter(el => el.textContent.trim().includes(str.trim()));
                        }

                        const ulCat3 = document.getElementById('caty_3');
                        const liCat3 = getElementsByIncludedText('Classical Guitars', 'li', ulCat3)[0];
                        liCat3.click();
                    })
                ]);

                console.log('OK: category selected successfully.');

                // The form is on page now

                // fill the form (except fields contained in iframes)
                await page.evaluate((information) => {
                    const titleInput = document.getElementById('editpane_title');
                    const upcInput = document.getElementById('upc');
                    const conditionSelect = document.getElementById('itemCondition');
                    const brandInput = document.getElementById('Listing.Item.ItemSpecific[Brand]');
                    const mpnInput = document.getElementById('Listing.Item.ItemSpecific[MPN]');
                    const formatSelect = document.getElementById('format');
                    const durationSelect = document.getElementById('duration');
                    const startPriceInput = document.getElementById('startPrice');
                    const binPriceInput = document.getElementById('binPrice');
                    const quantityInput = document.getElementById('quantity');
                    const scheduleInput = document.getElementById('schldLstng_1'); // radio select. Then I should deal with select#startDate
                    const paypalCheck = document.getElementById('pmPayPal');
                    const paypalEmailInput = document.getElementById('paypalEmail');
                    const domesticShipSelect = document.getElementById('domesticShipping');
                    const itemLocationBtn = document.getElementById('anLocId'); // to be clicked!
                    const countrySelect = document.getElementById('v4-55'); // name="itemCountry"
                    const postalCodeInput = document.getElementById('itemPostalCode');
                    const cityOrStateInput = document.getElementById('location');
                    // const actionButtons = document.querySelectorAll('#actionbar > input');

                    // click location button
                    itemLocationBtn.click();

                    titleInput.value = information.title;
                    // condition
                    Array.from(conditionSelect.options).forEach(el => {
                        if (el.text === information.condition)
                            conditionSelect.options.selectedIndex = el.index;
                    });
                    brandInput.value = information.brand;
                    mpnInput.value = information['Manufacturer Part Number'];
                    // format
                    Array.from(formatSelect.options).forEach(el => {
                        if (el.text === information.format)
                            formatSelect.options.selectedIndex = el.index;
                    });
                    // duration
                    if (durationSelect) {
                        Array.from(durationSelect.options).forEach(el => {
                            if (el.text === information.duration)
                                durationSelect.options.selectedIndex = el.index;
                        });
                    }
                    if (startPriceInput) startPriceInput.value = information['starting price'];
                    if (binPriceInput) binPriceInput.value = information['Buy It Now price'];
                    quantityInput.value = information.quantity;
                    paypalCheck.checked = information['Payment options'] === 'Paypal' ? true : false;
                    if (paypalCheck.checked) paypalEmailInput.value = information['Paypal email'];
                    // domesticShip
                    Array.from(domesticShipSelect.options).forEach(el => {
                        if (el.text.includes(information['domestic shipping']))
                            domesticShipSelect.options.selectedIndex = el.index;
                    });
                    // // itemLocationBtn is already clicked!!
                    // Array.from(countrySelect.options).forEach(el => {
                    //     if (el.text === information['Item location'].country)
                    //         countrySelect.options.selectedIndex = el.index;
                    // });
                    // postalCodeInput.value = information['Item location'].postalCode;
                    // cityOrStateInput.value = information['Item location'].city;
                }, information);

                // get the right frames: photo upload and description
                const availableFrames2 = page.mainFrame().childFrames();
                let cwFrame;
                let descFrame;
                for (const item of availableFrames2) {
                    if (item._name === 'uploader_iframe') cwFrame = item;
                    if (item._name === 'v4-41txtEdit_st') descFrame = item;
                }

                // insert photo url (first click 'import from web button', then set value. No click on import button)
                await cwFrame.evaluate((photosUrlArr) => {
                    const getElementsByIncludedText = (str, tag, rootElement = document) => {
                        return Array.prototype.slice.call(rootElement.getElementsByTagName(tag)).filter(el => el.textContent.trim().includes(str.trim()));
                    }

                    const topmsg = document.getElementById('tm-topMsg');
                    const importFromWebButton = getElementsByIncludedText('Import from web', 'a', topmsg)[0];

                    importFromWebButton.click();

                    const photoInput = document.querySelector('input[title="Enter the URL where your photo is located"]');
                    photoInput.value = photosUrlArr[0];
                }, information.photos);

                await sleep(1000);

                // click import button and wait for importing to finish
                const [ response2 ] = await Promise.all([
                    // wait for the right response that shows import success
                    page.waitForResponse((res) => {
                        // console.log('Reading response url:', res._url);
                        return res.url().includes('https://i.ebayimg.com');
                    }, { timeout: 120*1000 }),
                    // click import button
                    cwFrame.evaluate((photosUrlArr) => {
                        const importBtn = document.querySelector('div.buttonPair > a.btn.btn-prim.btn-m[role="button"]');
                        importBtn.click();
                    })
                ]);

                log.info('Image uploaded successfully!');

                // insert description text
                await descFrame.evaluate((descriptionText) => {
                    const body = document.querySelector('body');
                    body.innerHTML = descriptionText;
                }, information['item description']);

                // create promise to wait for right response
                const responsePromise = page.waitForResponse((res) => {
                    return res.url() === 'https://bulksell.ebay.com/V4Ajax'
                        && res.status() === 200
                        && res.headers()['content-length'] > 1000;
                }, { timeout: 120*1000 });

                // click submit button
                await page.evaluate(() => {
                    const listItemButton = Array.from(document.querySelectorAll('#actionbar > input')).filter(btn => btn.value === 'List item')[0];
                    listItemButton.click();
                });

                // wait for promise and grab data
                const successDataRaw = await responsePromise;
                const successData = await successDataRaw.json();
                const itemId = successData.data.itemId;

                log.info(`
                    Item was uploaded successfully.
                    Item ID: ${itemId}
                    Link to the item page: ${BASE_ITEM_URL + itemId}
                `);

                log.info('Sending confirmation email...');
                await Apify.call('apify/send-mail', {
                    to: username,
                    subject: 'actor-ebay-upload: Item uploaded successfully.',
                    text: `Item was uploaded successfully.
                    Item ID: ${itemId}
                    Link to the item page: ${BASE_ITEM_URL + itemId}`
                });
                log.info('Email sent.');
            } // fine START
        },

        handleFailedRequestFunction: async ({ request }) => {
            log.warning(`Request ${request.url} failed too many times`);

            await dataset.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
    });

    log.info('Starting crawler.');
    await crawler.run();

    log.info('Crawler Finished.');
});

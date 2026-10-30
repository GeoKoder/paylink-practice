let cachedToken = null;
let tokenExpiryTime = null;

function getBaseUrl() {
    return process.env.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";
}

async function  getAccessToken() {
    if (cachedToken && tokenExpiryTime && Date.now() < tokenExpiryTime -60000) {
        return cachedToken;
    }

    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
        throw new Error(
            "Missing M-Pesa credentials. Set MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET in your .env file."
        )
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const baseUrl = getBaseUrl();

    const response = await fetch(
        `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, 
        {
            method: "GET",
            headers: {
                Authorization: `Basic ${auth}`,
            }
        }
    )

    if (!response.ok) {
        const errorData = await response.text();
        console.error("Daraja OAuth error:", response.status, errorData)
        cachedToken = null;
        tokenExpiryTime = null;
        throw new Error(`Daraja OAuth failed: ${response.status}`)
    }

    const data = await response.json();

    cachedToken = data.access_token;
    tokenExpiryTime = Date.now() + parseInt(data.expires_in, 10) * 1000;

    console.log(`New M-Pesa acces token obtained. Expires in ${data.expires_in} seconds.`);

    return cachedToken;
}

module.exports = { getAccessToken, getBaseUrl };
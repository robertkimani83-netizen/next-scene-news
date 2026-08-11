const APP_ID = process.env.FACEBOOK_APP_ID;
const APP_SECRET = process.env.FACEBOOK_APP_SECRET;
const SHORT_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

async function main() {
  console.log('Exchanging short-lived token for long-lived user token...');
  const exchangeUrl = `https://graph.facebook.com/v26.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${SHORT_TOKEN}`;
  const exchangeRes = await fetch(exchangeUrl);
  const exchangeData = await exchangeRes.json();

  if (!exchangeData.access_token) {
    console.error('FAILED to get long-lived user token:', JSON.stringify(exchangeData));
    process.exit(1);
  }

  const longLivedUserToken = exchangeData.access_token;
  console.log('Got long-lived user token (expires in ~60 days).');

  console.log('Fetching Pages linked to this user token...');
  const pagesRes = await fetch(`https://graph.facebook.com/v26.0/me/accounts?access_token=${longLivedUserToken}`);
  const pagesData = await pagesRes.json();

  if (!pagesData.data || !pagesData.data.length) {
    console.error('FAILED to find any Pages:', JSON.stringify(pagesData));
    process.exit(1);
  }

  console.log('Found Pages:');
  for (const page of pagesData.data) {
    console.log(`- ${page.name} (id: ${page.id})`);
    console.log(`  PAGE ACCESS TOKEN: ${page.access_token}`);
  }

  console.log('\nCopy the PAGE ACCESS TOKEN for Vox254news above and save it as FACEBOOK_PAGE_ACCESS_TOKEN in both Vercel and GitHub secrets. This Page token generated this way does not expire.');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});

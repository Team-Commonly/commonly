const fs = require('fs');
const https = require('https');
const path = require('path');

// Aiven CA certificate URL
const CA_URL = 'https://api.aiven.io/ca.pem';
const OUTPUT_PATH = path.join(__dirname, 'ca.pem');

console.log(`Downloading CA certificate from ${CA_URL} to ${OUTPUT_PATH}...`);

https.get(CA_URL, (res) => {
  if (res.statusCode !== 200) {
    console.error(`Failed to download CA certificate: ${res.statusCode} ${res.statusMessage}`);
    process.exit(1);
  }

  const fileStream = fs.createWriteStream(OUTPUT_PATH);
  res.pipe(fileStream);

  fileStream.on('finish', () => {
    console.log(`CA certificate downloaded successfully to ${OUTPUT_PATH}`);
    fileStream.close();
  });

  fileStream.on('error', (err) => {
    console.error(`Error writing CA certificate to file: ${err.message}`);
    fs.unlinkSync(OUTPUT_PATH);
    process.exit(1);
  });
}).on('error', (err) => {
  console.error(`Error downloading CA certificate: ${err.message}`);
  process.exit(1);
}); 
// Read only the previously registered brand names/readings. No product/customer data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DynamoDBClient} = require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient, ScanCommand} = require('@aws-sdk/lib-dynamodb');

async function main() {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({region: 'us-west-2'}));
  const sources = [];
  const pairs = new Map();
  for (const table of ['BrandTable', 'FilteredBrandsTable']) {
    let key, count = 0;
    do {
      const page = await client.send(new ScanCommand({TableName: table,
        ProjectionExpression: '#name, #reading',
        ExpressionAttributeNames: {'#name': 'BrandName', '#reading': 'BrandNameRead'},
        ExclusiveStartKey: key}));
      for (const row of page.Items ?? []) {
        const name = typeof row.BrandName === 'string' ? row.BrandName.trim() : '';
        const reading = typeof row.BrandNameRead === 'string' ? row.BrandNameRead.trim() : '';
        if (!name || !reading || /^(?:N\/A|なし|不明)$/i.test(reading)) continue;
        pairs.set(JSON.stringify([name, reading]), [name, reading]);
        count++;
      }
      key = page.LastEvaluatedKey;
    } while (key);
    sources.push({table, entries: count});
  }
  const brands = [...pairs.values()].sort((a, b) => a[0].localeCompare(b[0], 'en') || a[1].localeCompare(b[1], 'ja'));
  if (brands.length < 100 || !brands.some(([name, reading]) => /^arper$/i.test(name) && reading === 'アルペール')) {
    throw new Error('Incomplete brand dictionary; existing file was not changed');
  }
  const content = JSON.stringify(brands) + '\n';
  fs.writeFileSync(path.resolve('lib/brands/search.generated.json'), content);
  fs.writeFileSync(path.resolve('lib/brands/search.source.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), region: 'us-west-2', sources,
    entries: brands.length, bytes: Buffer.byteLength(content),
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  }, null, 2) + '\n');
  console.log(JSON.stringify({sources, entries: brands.length, bytes: Buffer.byteLength(content)}));
}
main().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });

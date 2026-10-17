const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function assertRegistered(root) {
  const owners = fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter(name => name.endsWith('.ts')).map(name => `src/${name.split(path.sep).join('/')}`);
  for (const config of ['tsconfig.json', 'tsconfig.typecheck.json']) {
    const included = new Set(JSON.parse(fs.readFileSync(path.join(root, config), 'utf8')).include);
    assert.deepEqual(owners.filter(owner => !included.has(owner)).sort(), [], `${config}: unregistered production owners`);
  }
}

test('every production TypeScript owner is explicitly registered', () => {
  assertRegistered(path.resolve(__dirname, '..'));
});

test('a new unregistered owner fails the inventory check', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-owner-inventory-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    for (const config of ['tsconfig.json', 'tsconfig.typecheck.json']) fs.writeFileSync(path.join(root, config), JSON.stringify({ include: [] }));
    assertRegistered(root);
    fs.writeFileSync(path.join(root, 'src', 'new-owner.ts'), 'export {};');
    assert.throws(() => assertRegistered(root), /unregistered production owners/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

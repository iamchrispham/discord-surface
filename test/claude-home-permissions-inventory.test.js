const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('direct-home permission decisions stay in their shared owner', () => {
  const ts = require('typescript');
  function permissionInventory(sources) {
   const result=[];
   for(const [file,text] of Object.entries(sources).sort()) {
    result.push({file,kind:'file'});
    const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    function visit(node) {
     const property=ts.isPropertyAccessExpression(node)&&node.name.text==='mode';
     const element=ts.isElementAccessExpression(node)&&ts.isStringLiteral(node.argumentExpression)&&node.argumentExpression.text==='mode';
     if(property||element) {
      let owner=node;
      while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
      let expression=node;
      while(expression.parent&&(ts.isBinaryExpression(expression.parent)||ts.isParenthesizedExpression(expression.parent)))expression=expression.parent;
      result.push({file,kind:'mode-read',owner:owner?.name?.text||'<module>',expression:expression.getText(ast).replace(/\s+/g,'')});
     }
     ts.forEachChild(node,visit);
    }
    visit(ast);
   }
   return result;
  }
  
  const directory = path.join(__dirname, '../src/claude/socket-ownership');
  const sources = {};
  function collect(root, prefix = '') {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      const absolute = path.join(root, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) collect(absolute, relative + '/');
      else if (/\.(ts|js|cjs|mjs)$/.test(entry.name)) sources[relative] = fs.readFileSync(absolute, 'utf8');
    }
  }
  collect(directory);
  const expected = [
  {
    "file": "bound-identity.ts",
    "kind": "file"
  },
  {
    "file": "lock-owner.ts",
    "kind": "file"
  },
  {
    "file": "lock.ts",
    "kind": "file"
  },
  {
    "file": "path.ts",
    "kind": "file"
  },
  {
    "file": "quarantine.ts",
    "kind": "file"
  },
  {
    "file": "quarantine.ts",
    "kind": "mode-read",
    "owner": "readQuarantine",
    "expression": "!quarantineStats.isDirectory()||quarantineStats.isSymbolicLink()||(ownerUid!==undefined&&quarantineStats.uid!==ownerUid)||(quarantineStats.mode&0o077)!==0||!ownerStats.isFile()||ownerStats.isSymbolicLink()||!manifestStats.isFile()||manifestStats.isSymbolicLink()||(ownerUid!==undefined&&(ownerStats.uid!==ownerUid||manifestStats.uid!==ownerUid))||(ownerStats.mode&0o077)!==0||(manifestStats.mode&0o077)!==0"
  },
  {
    "file": "quarantine.ts",
    "kind": "mode-read",
    "owner": "readQuarantine",
    "expression": "!quarantineStats.isDirectory()||quarantineStats.isSymbolicLink()||(ownerUid!==undefined&&quarantineStats.uid!==ownerUid)||(quarantineStats.mode&0o077)!==0||!ownerStats.isFile()||ownerStats.isSymbolicLink()||!manifestStats.isFile()||manifestStats.isSymbolicLink()||(ownerUid!==undefined&&(ownerStats.uid!==ownerUid||manifestStats.uid!==ownerUid))||(ownerStats.mode&0o077)!==0||(manifestStats.mode&0o077)!==0"
  },
  {
    "file": "quarantine.ts",
    "kind": "mode-read",
    "owner": "readQuarantine",
    "expression": "!quarantineStats.isDirectory()||quarantineStats.isSymbolicLink()||(ownerUid!==undefined&&quarantineStats.uid!==ownerUid)||(quarantineStats.mode&0o077)!==0||!ownerStats.isFile()||ownerStats.isSymbolicLink()||!manifestStats.isFile()||manifestStats.isSymbolicLink()||(ownerUid!==undefined&&(ownerStats.uid!==ownerUid||manifestStats.uid!==ownerUid))||(ownerStats.mode&0o077)!==0||(manifestStats.mode&0o077)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "file"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "assertLockNamespaceIsUsable",
    "expression": "!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o077)!==0||(owner!==undefined&&directory.uid!==owner)"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "isOwnerControlledHome",
    "expression": "directory.isDirectory()&&!directory.isSymbolicLink()&&(owner===undefined||directory.uid===owner)&&(owner===undefined||(directory.mode&0o200)!==0)&&(directory.mode&0o022)===0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "isOwnerControlledHome",
    "expression": "directory.isDirectory()&&!directory.isSymbolicLink()&&(owner===undefined||directory.uid===owner)&&(owner===undefined||(directory.mode&0o200)!==0)&&(directory.mode&0o022)===0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "publishedFallbackRoot",
    "expression": "(directory.mode&0o1000)!==0&&(directory.mode&0o002)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "publishedFallbackRoot",
    "expression": "(directory.mode&0o1000)!==0&&(directory.mode&0o002)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "publishedFallbackRoot",
    "expression": "!rendezvousStats.isDirectory()||rendezvousStats.isSymbolicLink()||!rendezvousOwnerControlled||(rendezvousStats.mode&0o077)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "publishedFallbackRoot",
    "expression": "!directHomeMarker.isFile()||directHomeMarker.isSymbolicLink()||!directMarkerOwnerControlled||(directHomeMarker.mode&0o077)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "publishedFallbackRoot",
    "expression": "!marker.isFile()||marker.isSymbolicLink()||!markerOwnerControlled||(marker.mode&0o077)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "publishedFallbackRoot",
    "expression": "owner===undefined||(privateDirectory.mode&0o200)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "publishedFallbackRoot",
    "expression": "privateDirectory.isDirectory()&&!privateDirectory.isSymbolicLink()&&privateOwnerControlled&&privateOwnerWritable&&(privateDirectory.mode&0o077)===0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "fallbackRendezvousClaimed",
    "expression": "(directory.mode&0o1000)!==0&&(directory.mode&0o002)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "fallbackRendezvousClaimed",
    "expression": "(directory.mode&0o1000)!==0&&(directory.mode&0o002)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "fallbackRendezvousClaimed",
    "expression": "rendezvousStats.isDirectory()&&!rendezvousStats.isSymbolicLink()&&rendezvousOwnerControlled&&(rendezvousStats.mode&0o077)===0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "publishDirectHomeRendezvous",
    "expression": "(directory.mode&0o1000)!==0&&(directory.mode&0o002)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "publishDirectHomeRendezvous",
    "expression": "(directory.mode&0o1000)!==0&&(directory.mode&0o002)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "publishDirectHomeRendezvous",
    "expression": "stats.isDirectory()&&!stats.isSymbolicLink()&&ownerControlled&&(stats.mode&0o077)===0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "!stableDirectory.isDirectory()||(stableDirectory.mode&0o1000)===0||(stableDirectory.mode&0o002)===0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "!stableDirectory.isDirectory()||(stableDirectory.mode&0o1000)===0||(stableDirectory.mode&0o002)===0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "(directory.mode&0o1000)!==0&&(directory.mode&0o002)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "(directory.mode&0o1000)!==0&&(directory.mode&0o002)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "owner===undefined||(directory.mode&0o200)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "directory.isDirectory()&&!directory.isSymbolicLink()&&ownerControlled&&ownerWritable&&(directory.mode&0o077)===0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "owner===undefined||(marker.mode&0o200)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "!marker.isFile()||marker.isSymbolicLink()||!markerOwnerControlled||!markerOwnerWritable||(marker.mode&0o077)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "owner===undefined||(privateDirectory.mode&0o200)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "!privateDirectory.isDirectory()||privateDirectory.isSymbolicLink()||!privateOwnerControlled||!privateOwnerWritable||(privateDirectory.mode&0o077)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "owner===undefined||(privateDirectory.mode&0o200)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "privateDirectory.isDirectory()&&!privateDirectory.isSymbolicLink()&&privateOwnerControlled&&privateOwnerWritable&&(privateDirectory.mode&0o077)===0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "!marker.isFile()||marker.isSymbolicLink()||(marker.mode&0o077)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "owner===undefined||(privateDirectory.mode&0o200)!==0"
  },
  {
    "file": "rendezvous.ts",
    "kind": "mode-read",
    "owner": "ownerControlledNamespaceRoot",
    "expression": "privateDirectory.isDirectory()&&!privateDirectory.isSymbolicLink()&&privateOwnerControlled&&privateOwnerWritable&&(privateDirectory.mode&0o077)===0"
  },
  {
    "file": "types.ts",
    "kind": "file"
  }
];
  assert.deepEqual(permissionInventory(sources), expected);
});

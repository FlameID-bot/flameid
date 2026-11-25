#!/usr/bin/env node
// Compile contracts/FlameID.sol (+ test mock) with solc 0.8.26.
// Outputs: build/FlameID.json { abi, bytecode }, build/MockAgentID.json,
//          build/IAgentID.json,
//          verify/standard-json-input.json + verify/standard-json-input-crlf.json
//          (for BscScan / Sourcify verification — the CRLF variant is the
//          one that matched the Remix deploy bytecode exactly in a past
//          deploy of this same contract family).
//
// Compiler: loads solc 0.8.26 remotely (exact version the contract pragma
// pins and Remix will use at deploy). Falls back to the bundled solc-js
// compiler with a loud warning if the remote load fails — in that case
// re-run after network is back before deploying/verifying.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.join(__dirname, "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const TEST_DIR = path.join(ROOT, "test");
const BUILD_DIR = path.join(ROOT, "build");
const VERIFY_DIR = path.join(ROOT, "verify");
const NODE_MODULES = path.join(ROOT, "node_modules");

const REMOTE_VERSION = "v0.8.26+commit.8a97fa7a";

function readSource(file) {
  return fs.readFileSync(file, "utf8");
}

function loadCompiler() {
  return new Promise((resolve) => {
    solc.loadRemoteVersion(REMOTE_VERSION, (err, remoteSolc) => {
      if (err || !remoteSolc) {
        console.log(
          `WARNING: could not load remote solc ${REMOTE_VERSION} (${err && err.message ? err.message : "unknown error"}). ` +
            `Falling back to bundled solc ${solc.version()} — DO NOT deploy/verify with this build.`
        );
        resolve({ compiler: solc, version: solc.version(), remote: false });
      } else {
        console.log(`using remote solc ${remoteSolc.version()}`);
        resolve({ compiler: remoteSolc, version: remoteSolc.version(), remote: true });
      }
    });
  });
}

async function main() {
  const { compiler, version, remote } = await loadCompiler();

  const mainSource = readSource(path.join(CONTRACTS_DIR, "FlameID.sol"));
  const mockSource = readSource(path.join(TEST_DIR, "MockAgentID.sol"));

  // All sources solc sees, keyed by source unit name. The import callback
  // fills in the @openzeppelin entries as the compiler requests them.
  const sources = {
    "FlameID.sol": { content: mainSource },
    "MockAgentID.sol": { content: mockSource },
  };

  function findImports(importPath) {
    if (importPath.startsWith("@openzeppelin/")) {
      const file = path.join(NODE_MODULES, importPath);
      try {
        const content = readSource(file);
        sources[importPath] = { content };
        return { contents: content };
      } catch (e) {
        return { error: `cannot read ${importPath}: ${e.message}` };
      }
    }
    return { error: `unresolvable import: ${importPath}` };
  }

  const input = {
    language: "Solidity",
    sources: {
      "FlameID.sol": sources["FlameID.sol"],
      "MockAgentID.sol": sources["MockAgentID.sol"],
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
      },
    },
  };

  const output = JSON.parse(
    compiler.compile(JSON.stringify(input), { import: findImports })
  );

  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === "error");
    for (const e of output.errors) console.log(e.formattedMessage);
    if (fatal.length > 0) {
      console.error(`COMPILATION FAILED (${fatal.length} error(s))`);
      process.exit(1);
    }
  }

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(VERIFY_DIR, { recursive: true });

  for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      const artifact = {
        contractName: name,
        sourceName: file,
        compilerVersion: version,
        compilerRemote: remote,
        abi: c.abi,
        bytecode: "0x" + c.evm.bytecode.object,
        deployedBytecode: "0x" + c.evm.deployedBytecode.object,
      };
      fs.writeFileSync(
        path.join(BUILD_DIR, `${name}.json`),
        JSON.stringify(artifact, null, 2)
      );
      console.log(
        `compiled ${name} (${file}) — bytecode ${artifact.bytecode.length / 2 - 1} bytes`
      );
    }
  }

  // Standard JSON input for BscScan / Sourcify verification (main contract
  // only, plus every @openzeppelin source the compiler pulled in).
  const verifySources = {};
  for (const [name, src] of Object.entries(sources)) {
    if (name === "MockAgentID.sol") continue;
    verifySources[name] = src;
  }
  const verifyInput = {
    language: "Solidity",
    sources: verifySources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
    },
  };
  fs.writeFileSync(
    path.join(VERIFY_DIR, "standard-json-input.json"),
    JSON.stringify(verifyInput, null, 2)
  );
  console.log("wrote verify/standard-json-input.json");

  // CRLF variant: same sources with CRLF line endings (matches what Remix
  // produces when the file is pasted from a CRLF copy — verified against
  // a past Remix deploy of this same contract family).
  const crlfSources = {};
  for (const [name, src] of Object.entries(verifySources)) {
    crlfSources[name] = {
      content: src.content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"),
    };
  }
  const verifyInputCrlf = {
    language: "Solidity",
    sources: crlfSources,
    settings: verifyInput.settings,
  };
  fs.writeFileSync(
    path.join(VERIFY_DIR, "standard-json-input-crlf.json"),
    JSON.stringify(verifyInputCrlf, null, 2)
  );
  console.log("wrote verify/standard-json-input-crlf.json");
  console.log(`COMPILE OK (solc ${version}${remote ? " remote" : " BUNDLED FALLBACK"})`);
}

main().catch((e) => {
  console.error("COMPILE SCRIPT ERROR:", e);
  process.exit(1);
});

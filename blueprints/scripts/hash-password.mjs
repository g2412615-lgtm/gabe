// Optional: prints a scrypt hash of a password for APP_PASSWORD_HASH, so the
// plain password never has to be stored anywhere. Usage:
//   node scripts/hash-password.mjs
// (it asks for the password without echoing it)
import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import readline from "node:readline";

const scryptAsync = promisify(scrypt);
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function ask() {
  if (process.argv[2]) return process.argv[2];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = () => {};
  process.stdout.write("Password: ");
  const pw = await new Promise((r) => rl.question("", r));
  rl.close();
  process.stdout.write("\n");
  return pw;
}

const pw = await ask();
if (!pw || pw.length < 8) {
  console.error("Use at least 8 characters.");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = await scryptAsync(pw, salt, 32, PARAMS);
console.log(`scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`);

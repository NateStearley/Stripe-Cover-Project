/** Stand-in for link-cli's entry point: echoes argv, or fails like link-cli does when unauthenticated. */
export const LINK_CLI_FAKE_SCRIPT = `
const argv = process.argv.slice(2);
if (argv.includes("lsrq_fail")) {
  console.log(JSON.stringify({ code: "UNKNOWN", message: 'Not authenticated. Run "link-cli auth login" first.' }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ id: "lsrq_echo", status: "created", argv }, null, 2));
`;

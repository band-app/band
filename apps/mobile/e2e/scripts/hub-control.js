// Stops or restarts the throwaway hub through the control server verify.mjs runs.
// CONTROL_URL comes from verify.mjs (-e), ACTION from the flow step ("stop" or "start").
const response = http.post(`${CONTROL_URL}/${ACTION}`, { body: "" });
if (response.status !== 200) {
  throw new Error(`hub ${ACTION} failed: HTTP ${response.status} ${response.body}`);
}

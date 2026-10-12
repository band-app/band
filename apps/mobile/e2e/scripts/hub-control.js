// Drives the throwaway hub through the control server verify.mjs runs.
// CONTROL_URL comes from verify.mjs (-e). ACTION is a path with its query, for example
// "stop", "start", "work?wt=alpha-main", "ask?wt=beta-main" or "sleep?ms=60000".
const response = http.post(`${CONTROL_URL}/${ACTION}`, { body: "" });
if (response.status !== 200) {
  throw new Error(`hub ${ACTION} failed: HTTP ${response.status} ${response.body}`);
}

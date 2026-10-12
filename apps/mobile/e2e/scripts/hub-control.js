// Drives the throwaway hub through the control server verify.mjs runs.
// CONTROL_URL comes from verify.mjs (-e). ACTION is a path with its query, for example
// "stop", "start", "work?wt=alpha-main", "ask?wt=beta-main" or "sleep?ms=60000". VALUE, when
// set, is added URL-encoded as `value`, for text with spaces ("note?name=fling" with the text
// a flow copied, "clipboard" with the text it expects).
const value =
  typeof VALUE === "undefined"
    ? ""
    : `${ACTION.includes("?") ? "&" : "?"}value=${encodeURIComponent(VALUE)}`;
const response = http.post(`${CONTROL_URL}/${ACTION}${value}`, { body: "" });
if (response.status !== 200) {
  throw new Error(`hub ${ACTION} failed: HTTP ${response.status} ${response.body}`);
}

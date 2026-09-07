// These servers are loopback-only. Reject browser cross-origin calls and DNS rebinding.
function isTrustedLocalRequest(req) {
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}
function rejectUntrustedRequest(req, res) {
  if (isTrustedLocalRequest(req)) return false;
  res.writeHead(403, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify({ok:false,error:'仅允许本机同源请求'}));
  return true;
}
module.exports = { isTrustedLocalRequest, rejectUntrustedRequest };

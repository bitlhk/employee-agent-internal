(function () {
  var params = new URLSearchParams(window.location.search);
  var status = params.get("status") === "success" ? "success" : "error";
  var message = params.get("message") || (status === "success" ? "连接器授权成功" : "连接器授权失败");
  document.getElementById("title").textContent = status === "success" ? "授权成功" : "授权失败";
  document.getElementById("message").textContent = message;
  if (window.opener) {
    window.opener.postMessage({ type: "employee-agent:mcp-oauth", status: status, message: message }, window.location.origin);
  }
  if (status === "success") window.setTimeout(function () { window.close(); }, 900);
}());

window.addEventListener("message", (e) => {
  if (e.data?.command === "loadCcdaXml") {
    loadCcdaXml(e.data.value);
    e.ports[0].postMessage({ result: true });
  }
});

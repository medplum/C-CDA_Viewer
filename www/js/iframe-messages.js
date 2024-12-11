window.addEventListener("message", (e) => {
  if (e.data?.command === "setCcdaXml") {
    setCdaXml(e.data.value);
    e.ports[0].postMessage({ result: true });
  }
});

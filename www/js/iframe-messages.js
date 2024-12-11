window.addEventListener("message", (e) => {
  console.log({ data: e.data });
  if (e.data?.command === "setCcdaXml") {
    setCdaXml(e.data.value);
    e.ports[0].postMessage({ result: true });
  }
});

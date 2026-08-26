import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl }) => {
  const root = await fetch(`${baseUrl}/`);
  const rootHtml = await root.text();
  assert(root.ok, "root should serve the official site");
  assert(rootHtml.includes("/official-site/assets/"), "official site should use its isolated asset namespace");

  for (const [path, marker] of [
    ["/studio", "portalAuthCard"],
    ["/studio/workbench", "chatLog"],
    ["/studio/market", "VibeBoard 应用市场"],
    ["/studio/devices", "portalAuthCard"],
    ["/studio/styles.css", "--vb-theme-name"],
    ["/official-site/assets/vexis-logo-transparent.png", ""],
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    const body = await response.text();
    assert(response.ok, `${path} should be reachable`);
    if (marker) assert(body.includes(marker), `${path} should serve its expected content`);
  }

  for (const [legacyPath, canonicalPath] of [
    ["/portal.html", "/studio"],
    ["/workbench?board=taishan-gray", "/studio/workbench?board=taishan-gray"],
    ["/market.html", "/studio/market"],
  ]) {
    const response = await fetch(`${baseUrl}${legacyPath}`, { redirect: "manual" });
    assert(response.status === 302, `${legacyPath} should redirect to its canonical route`);
    assert(response.headers.get("location") === canonicalPath, `${legacyPath} should retain its canonical destination`);
  }
}, { dbPrefix: "domain-routing", wait: { path: "/api/health" } });

console.log("domain routing ok");

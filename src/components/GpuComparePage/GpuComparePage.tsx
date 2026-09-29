/**
 * GpuComparePage — embeds the third-party spark-dashboard (niklasfrick) GPU/
 * vLLM monitor in an iframe, for side-by-side comparison against sparkDash's
 * own panels. Fixed tab, same family as OverviewPage/ServicesPage.
 */
// Same host the browser used to reach sparkDash (LAN or Tailscale), so the
// embed keeps working when the Spark's IP or subnet changes.
const GPU_DASHBOARD_URL = `${window.location.protocol}//${window.location.hostname}:3500`;

export function GpuComparePage() {
  return (
    <div className="panel" style={{ height: "calc(100vh - 220px)", minHeight: 560, overflow: "hidden", padding: 0 }}>
      <iframe
        src={GPU_DASHBOARD_URL}
        title="Spark Dashboard"
        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
        allow="fullscreen"
      />
    </div>
  );
}

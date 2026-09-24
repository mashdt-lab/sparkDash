/**
 * GpuComparePage — embeds the third-party spark-dashboard (niklasfrick) GPU/
 * vLLM monitor in an iframe, for side-by-side comparison against sparkDash's
 * own panels. Fixed tab, same family as OverviewPage/ServicesPage.
 */
const GPU_DASHBOARD_URL = "http://192.168.88.80:3500";

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

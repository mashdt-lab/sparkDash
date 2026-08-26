import { useEffect, useState } from "react";
import type { ServiceInfo, SparkSnapshot } from "../../api/types";
import { fetchServices } from "../../api/client";
import { ServiceCard } from "./ServiceCard";

const POLL_MS = 8_000;
const CATEGORY_ORDER = ["AI & Creative", "Automation", "Infrastructure", "System"];

export function ServicesPage({ spark }: { spark: SparkSnapshot | null }) {
  const [services, setServices] = useState<ServiceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!spark) return;
    let cancelled = false;
    const load = () => {
      fetchServices(spark.id)
        .then((res) => {
          if (cancelled) return;
          setServices(res.services || []);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [spark]);

  if (!spark) {
    return (
      <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
        <h2 className="text-sm font-semibold text-text-strong">No Spark registered</h2>
        <p className="mt-1 text-xs text-muted">
          Add a DGX Spark unit first to see its services here.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
        <h2 className="text-sm font-semibold text-text-strong">Couldn't load services</h2>
        <p className="mt-1 text-xs text-muted">{error}</p>
      </div>
    );
  }

  if (!services) {
    return <p className="mt-8 text-center text-xs text-muted">Loading services…</p>;
  }

  const byCategory = new Map<string, ServiceInfo[]>();
  for (const svc of services) {
    const list = byCategory.get(svc.category) ?? [];
    list.push(svc);
    byCategory.set(svc.category, list);
  }
  const categories = [
    ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  return (
    <div className="services-page space-y-6">
      {categories.map((category) => (
        <section key={category}>
          <h2
            className="mb-3 font-normal leading-tight tracking-tight text-text-strong"
            style={{ fontSize: "var(--density-overview-title)" }}
          >
            {category}
          </h2>
          <div
            className="grid sm:grid-cols-2 lg:grid-cols-3"
            style={{ gap: "var(--density-page-gap)" }}
          >
            {byCategory.get(category)!.map((svc) => (
              <ServiceCard key={svc.id} service={svc} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

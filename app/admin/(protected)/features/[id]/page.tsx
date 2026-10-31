import { notFound } from "next/navigation";
import { getFeatureWithItems } from "@/lib/features/queries";
import { FeatureEditor } from "./FeatureEditor";

// Live admin data (and calls the real/mock BASE client) on every request.
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function FeatureEditPage(props: Props) {
  const params = await props.params;
  const feature = await getFeatureWithItems(params.id);
  if (!feature) notFound();

  return <FeatureEditor feature={feature} />;
}

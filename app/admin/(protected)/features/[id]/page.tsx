import { notFound } from "next/navigation";
import { getFeatureWithItems } from "@/lib/features/queries";
import { FeatureEditor } from "./FeatureEditor";

interface Props {
  params: { id: string };
}

export default async function FeatureEditPage({ params }: Props) {
  const feature = await getFeatureWithItems(params.id);
  if (!feature) notFound();

  return <FeatureEditor feature={feature} />;
}

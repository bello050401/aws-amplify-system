"use client";

import { useEffect, useState } from "react";
import { getInventoryService } from "@/lib/api";
import type { Category, Location } from "@/lib/types";

type MasterData = { categories: Category[]; locations: Location[] };

let cache: MasterData | null = null;
let inflight: Promise<MasterData> | null = null;

async function loadMasterData(): Promise<MasterData> {
  if (cache) return cache;
  if (!inflight) {
    const service = getInventoryService();
    inflight = Promise.all([service.listCategories(), service.listLocations()]).then(
      ([categories, locations]) => {
        cache = { categories, locations };
        return cache;
      }
    );
  }
  return inflight;
}

/** カテゴリ・保管場所マスタ(既存BELLO側の共通マスタ)を取得する共通フック。 */
export function useMasterData() {
  const [data, setData] = useState(cache);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    let active = true;
    if (!cache) {
      loadMasterData().then((d) => {
        if (active) {
          setData(d);
          setLoading(false);
        }
      });
    }
    return () => {
      active = false;
    };
  }, []);

  return {
    categories: data?.categories ?? [],
    locations: data?.locations ?? [],
    loading,
  };
}

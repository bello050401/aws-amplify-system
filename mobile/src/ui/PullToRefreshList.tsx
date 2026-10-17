import React from "react";
import { FlatList, type FlatListProps } from "react-native";

export type PullToRefreshListProps<T> = Omit<FlatListProps<T>, "onRefresh"> & { onRefresh: () => Promise<void> };

/** Native iOS/Android use their platform refresh control. */
export function PullToRefreshList<T>(props: PullToRefreshListProps<T>) {
  return <FlatList {...props} alwaysBounceVertical />;
}

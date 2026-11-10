import React from "react";
import { FlatList, type FlatListProps } from "react-native";

export type PullToRefreshListProps<T> = Omit<FlatListProps<T>, "onRefresh"> & { onRefresh: () => Promise<void>; onPositionChange?: (offset: number) => void };

/** Native iOS/Android use their platform refresh control. */
export function PullToRefreshList<T>({onPositionChange, ...props}: PullToRefreshListProps<T>) {
  return <FlatList {...props} onScroll={event=>{onPositionChange?.(event.nativeEvent.contentOffset.y);props.onScroll?.(event);}} alwaysBounceVertical />;
}

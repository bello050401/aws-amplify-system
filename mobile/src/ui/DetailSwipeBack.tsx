import React, { useEffect, useRef } from "react";
import { Animated, PanResponder, StyleSheet, View } from "react-native";
import { EdgeSwipeBackGesture } from "../domain/edgeSwipeBack";
import { colors } from "./theme";

export type DetailSwipeBackProps = React.PropsWithChildren<{ enabled: boolean; onBack: () => void }>;

export function DetailSwipeBack({ enabled, onBack, children }: DetailSwipeBackProps) {
  const latest = useRef({ enabled, onBack }); latest.current = { enabled, onBack };
  const root = useRef<React.ElementRef<typeof View>>(null), bounds = useRef({ left: 0, width: 0 });
  const gesture = useRef(new EdgeSwipeBackGesture()).current;
  const offset = useRef(new Animated.Value(0)).current;
  const busy = useRef(false);
  const finish = (cancelled: boolean) => {
    const moved = gesture.distance > 0;
    const back = !cancelled && gesture.release(); gesture.cancel();
    if (busy.current) return;
    if (!moved) { offset.setValue(0); return; }
    busy.current = true;
    Animated.timing(offset, { toValue: back ? bounds.current.width : 0, duration: 160, useNativeDriver: true }).start(({ finished }) => {
      busy.current = false;
      if (finished && back && latest.current.enabled) latest.current.onBack();
      offset.setValue(0);
    });
  };
  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponderCapture: event => {
      gesture.begin(event.nativeEvent.pageX - bounds.current.left, event.nativeEvent.pageY, bounds.current.width,
        latest.current.enabled && !busy.current && event.nativeEvent.touches.length === 1);
      return false;
    },
    onMoveShouldSetPanResponderCapture: (event, state) => {
      if (!latest.current.enabled || busy.current || event.nativeEvent.touches.length !== 1) { gesture.cancel(); return false; }
      return gesture.move(state.moveX - bounds.current.left, state.moveY);
    },
    onPanResponderMove: (event, state) => {
      if (event.nativeEvent.touches.length !== 1) { finish(true); return; }
      gesture.move(state.moveX - bounds.current.left, state.moveY); offset.setValue(gesture.distance);
    },
    onPanResponderRelease: () => finish(false),
    onPanResponderTerminate: () => finish(true),
    onPanResponderTerminationRequest: () => false,
  })).current;
  useEffect(() => {
    if (!enabled) { gesture.cancel(); offset.stopAnimation(); offset.setValue(0); busy.current = false; }
    return () => { gesture.cancel(); offset.stopAnimation(); };
  }, [enabled, gesture, offset]);
  return <View ref={root} style={[s.root, enabled && { backgroundColor: colors.cream }]} onLayout={event => {
    bounds.current.width = event.nativeEvent.layout.width;
    root.current?.measureInWindow(left => { bounds.current.left = left; });
  }} {...(enabled ? responder.panHandlers : {})}>
    <Animated.View style={[s.content, enabled && { backgroundColor: colors.cream }, { transform: [{ translateX: offset }] }]}>{children}</Animated.View>
  </View>;
}

const s = StyleSheet.create({
  root: { flex: 1, overflow: "hidden" },
  content: { flex: 1 },
});

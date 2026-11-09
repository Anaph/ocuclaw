import {
  EventSourceType,
  OsEventTypeList,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";

export type Input = "up" | "down" | "select" | "back" | "menu";

export function gesture(event: EvenHubEvent): Input | undefined {
  const captured = event.textEvent ?? event.listEvent;
  const system = event.sysEvent;
  const type = captured?.eventType ?? system?.eventType;
  switch (type) {
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return "up";
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return "down";
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return "back";
    case OsEventTypeList.CLICK_EVENT:
      return "select";
    case undefined:
      // The host can omit the default protobuf value (CLICK) on a captured row.
      if (
        captured ||
        (system?.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING &&
          !system.imuData &&
          system.systemExitReasonCode == null)
      )
        return "select";
  }
}

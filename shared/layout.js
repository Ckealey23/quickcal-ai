(function (root) {
  const MIN_SCALE = 0.8;
  const MAX_SCALE = 1.6;
  const FLOOR_SCALE = 0.45;
  const MARGIN = 16;
  const BASE_WIDTH = 456;
  const EXPANDED_WIDTH = 440;

  function naturalWidth(expanded) {
    return expanded ? EXPANDED_WIDTH : BASE_WIDTH;
  }

  function clampScale(scale, baseWidth, baseHeight, viewport) {
    let next = Number(scale);
    if (!isFinite(next) || next <= 0) next = 1;
    next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (!viewport || !(baseWidth > 0) || !(baseHeight > 0)) return next;
    const roomW = viewport.width - MARGIN * 2;
    const roomH = viewport.height - MARGIN * 2;
    if (roomW > 0) next = Math.min(next, roomW / baseWidth);
    if (roomH > 0) next = Math.min(next, roomH / baseHeight);
    if (next < MIN_SCALE) next = Math.max(FLOOR_SCALE, next);
    return next;
  }

  function clampPosition(left, top, width, height, viewport) {
    const roomW = Math.max(0, viewport.width - width);
    const roomH = Math.max(0, viewport.height - height);
    const minLeft = roomW >= MARGIN * 2 ? MARGIN : 0;
    const minTop = roomH >= MARGIN * 2 ? MARGIN : 0;
    const maxLeft = Math.max(minLeft, viewport.width - width - minLeft);
    const maxTop = Math.max(minTop, viewport.height - height - minTop);
    return {
      left: Math.min(Math.max(minLeft, left), maxLeft),
      top: Math.min(Math.max(minTop, top), maxTop),
    };
  }

  function defaultOrigin(width, height, viewport) {
    return clampPosition(
      viewport.width - width - MARGIN,
      viewport.height - height - MARGIN,
      width,
      height,
      viewport
    );
  }

  function scaleFromCorner(start, point, corner, viewport) {
    const widthDelta = corner === "nw" || corner === "sw"
      ? start.left + start.width - point.x
      : point.x - start.left;
    const heightDelta = corner === "nw" || corner === "ne"
      ? start.top + start.height - point.y
      : point.y - start.top;
    const widthScale = start.width > 0 ? widthDelta / start.width : 1;
    const heightScale = start.height > 0 ? heightDelta / start.height : 1;
    const factor = (widthScale + heightScale) / 2;
    const unclamped = start.scale * (factor > 0 ? factor : 0.01);
    const baseWidth = start.width / start.scale;
    const baseHeight = start.height / start.scale;
    const scale = clampScale(unclamped, baseWidth, baseHeight, viewport);
    const nextWidth = baseWidth * scale;
    const nextHeight = baseHeight * scale;
    const right = start.left + start.width;
    const bottom = start.top + start.height;
    const left = corner === "nw" || corner === "sw" ? right - nextWidth : start.left;
    const top = corner === "nw" || corner === "ne" ? bottom - nextHeight : start.top;
    const position = clampPosition(left, top, nextWidth, nextHeight, viewport);
    return { scale: scale, left: position.left, top: position.top, width: nextWidth, height: nextHeight };
  }

  root.QuickCalLayout = {
    MIN_SCALE: MIN_SCALE,
    MAX_SCALE: MAX_SCALE,
    MARGIN: MARGIN,
    BASE_WIDTH: BASE_WIDTH,
    EXPANDED_WIDTH: EXPANDED_WIDTH,
    naturalWidth: naturalWidth,
    clampScale: clampScale,
    clampPosition: clampPosition,
    defaultOrigin: defaultOrigin,
    scaleFromCorner: scaleFromCorner,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);

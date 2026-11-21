'use client';

/**
 * A subscription to the shared real-time stream.
 *
 * Messaging does not need its own connection: the notification provider owns one stream
 * per tab, and this hook hands a component the raw frame bodies from it. The listener
 * is held in a ref so a caller may pass an inline closure without re-subscribing on
 * every render — a re-subscribe per render would be a subscription leak in slow motion.
 */

import { useEffect, useRef } from 'react';

import { useNotifications } from './notifications';

export const useNotificationStream = (listener: (data: unknown) => void): void => {
  const { subscribeToFrames } = useNotifications();
  const latest = useRef(listener);

  useEffect(() => {
    latest.current = listener;
  }, [listener]);

  useEffect(() => subscribeToFrames((data) => latest.current(data)), [subscribeToFrames]);
};

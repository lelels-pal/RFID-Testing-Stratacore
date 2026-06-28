'use client';

import { useCallback, useState } from 'react';
import { RfidCard, ChargerConnectionInfo, OcppTraceEntry } from '@packages/shared';
import {
  fetchRfids as apiFetchRfids,
  fetchChargerConnections as apiFetchChargerConnections,
  fetchOcppTrace as apiFetchOcppTrace,
  fetchSiteConfig,
} from '../lib/api-client';
import { getChargerConfigs, STATION_NAME, STATION_LOCATION, type ChargerDefinition } from '../lib/config';

export function useKioskData(backendUrl: string, isLoggedIn: boolean) {
  const [chargerConfigs, setChargerConfigs] = useState<ChargerDefinition[]>(() => getChargerConfigs());
  const [stationName, setStationName] = useState(STATION_NAME);
  const [stationLocation, setStationLocation] = useState(STATION_LOCATION);
  const [rfidCards, setRfidCards] = useState<RfidCard[]>([]);
  const [chargerConnections, setChargerConnections] = useState<Record<string, ChargerConnectionInfo>>({});
  const [ocppTrace, setOcppTrace] = useState<OcppTraceEntry[]>([]);

  const loadSiteConfig = useCallback(async () => {
    try {
      const config = await fetchSiteConfig(backendUrl);
      if (config.chargers?.length) {
        setChargerConfigs(config.chargers);
      }
      if (config.stationName) setStationName(config.stationName);
      if (config.stationLocation) setStationLocation(config.stationLocation);
    } catch {
      // Fall back to env-based charger list.
    }
  }, [backendUrl]);

  const fetchRfids = useCallback(async () => {
    if (!isLoggedIn) return;
    try {
      const data = await apiFetchRfids(backendUrl);
      setRfidCards(data as RfidCard[]);
    } catch (err) {
      console.error('Error fetching RFID cards:', err);
    }
  }, [backendUrl, isLoggedIn]);

  const fetchChargerConnections = useCallback(async () => {
    if (!isLoggedIn) return;
    try {
      const ids = chargerConfigs.map((c) => c.chargerId);
      const data = (await apiFetchChargerConnections(backendUrl, ids)) as ChargerConnectionInfo[];
      setChargerConnections(Object.fromEntries(data.map((c) => [c.chargerId, c])));
    } catch (err) {
      console.error('Error fetching charger connections:', err);
    }
  }, [backendUrl, chargerConfigs, isLoggedIn]);

  const fetchOcppTrace = useCallback(
    async (showAllOcppPackets: boolean) => {
      if (!isLoggedIn) return;
      try {
        const data = (await apiFetchOcppTrace(backendUrl, !showAllOcppPackets)) as OcppTraceEntry[];
        setOcppTrace(data);
      } catch (err) {
        console.error('Error fetching OCPP trace:', err);
      }
    },
    [backendUrl, isLoggedIn],
  );

  return {
    chargerConfigs,
    stationName,
    stationLocation,
    rfidCards,
    setRfidCards,
    chargerConnections,
    setChargerConnections,
    ocppTrace,
    setOcppTrace,
    loadSiteConfig,
    fetchRfids,
    fetchChargerConnections,
    fetchOcppTrace,
  };
}

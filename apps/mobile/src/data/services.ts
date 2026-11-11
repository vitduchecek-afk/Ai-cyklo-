import { PhotonGeocoder } from '@trailpack/maps';
import { RoutingService, createDefaultProviders } from '@trailpack/routing';
import { HttpClient } from '@trailpack/shared';
import { OpenMeteoProvider } from '@trailpack/weather';

export const http = new HttpClient({});
export const routing = new RoutingService({ http, providers: createDefaultProviders({ http }) });
export const geocoder = new PhotonGeocoder(http);
export const weather = new OpenMeteoProvider({ http });

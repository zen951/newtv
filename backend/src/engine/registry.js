/**
 * engine/registry.js
 *
 * Central registry of all email providers and registration services.
 *
 * To add a provider: create email/<name>.js, import it, add to emailProviders[].
 * To add a service:  create services/<name>.js, import it, add to registrationServices[].
 */

import EmailnatorProvider from "../email/emailnator.js";
import DropMailProvider from "../email/dropmail.js";
import MailTmProvider from "../email/mailtm.js";
import TmailyProvider from "../email/tmaily.js";
import DisposeLolProvider from "../email/disposelol.js";
import HioMailProvider from "../email/hiomail.js";

import Y6TvService from "../services/y6tv.js";
import OgoTvService from "../services/ogotv.js";
import VeleStoreService from "../services/velestore.js";
import TvBoomService from "../services/tvboom.js";

import LibertyTvService from "../services/libertytv.js";
import OneIptv4kService from "../services/oneiptv4k.js";
import TvCornService from "../services/tvcorn.js";
import LayerSevenService from "../services/layerseven.js";
import KookaService from "../services/kooka.js";
import GreatestIptvService from "../services/greatestiptv.js";

import EmeraldIptvService from "../services/emeraldiptv.js";
import UspehService from "../services/uspeh.js";
import RuTvService from "../services/rutv.js";

export const emailProviders = [
  EmailnatorProvider,
  DropMailProvider,
  MailTmProvider,
  TmailyProvider,
  DisposeLolProvider,
  HioMailProvider,
];

export const registrationServices = [
  Y6TvService,
  OgoTvService,
  VeleStoreService,
  TvBoomService,

  LibertyTvService,
  OneIptv4kService,
  TvCornService,
  LayerSevenService,
  KookaService,
  GreatestIptvService,

  EmeraldIptvService,
  UspehService,
  RuTvService,
];

// Looks up a provider by its meta.id. Returns null if not found.
export function getProvider(id) {
  return emailProviders.find((p) => p.meta.id === id) ?? null;
}

// Looks up a service by its meta.id. Returns null if not found.
export function getService(id) {
  return registrationServices.find((s) => s.meta.id === id) ?? null;
}

/**
 * Where this deployment's source code lives. Saybeam is AGPL-3.0: if you
 * run a modified version for other people, set SAYBEAM_SOURCE_URL at build
 * time so this link points at your changes.
 */
declare const __SOURCE_URL__: string | undefined;

export const SOURCE_URL: string = typeof __SOURCE_URL__ === 'string' && __SOURCE_URL__ ? __SOURCE_URL__ : 'https://github.com/byjoellobo/saybeam';

export const LICENSE_NAME = 'AGPL-3.0-or-later';

/** Regulations / protected areas – shared between maps, regulations and ai packages. */
import { z } from 'zod';

/** ISO 3166-1 alpha-2 country code, upper case (e.g. 'CZ'). */
export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
export type CountryCode = z.infer<typeof CountryCodeSchema>;

export const ProtectedAreaKindSchema = z.enum([
  'national_park',
  'protected_landscape_area',
  'nature_reserve',
  'natural_monument',
  'natura2000',
  'other',
]);
export type ProtectedAreaKind = z.infer<typeof ProtectedAreaKindSchema>;

export const ProtectedAreaInfoSchema = z.object({
  name: z.string(),
  kind: ProtectedAreaKindSchema,
  /** OSM protect_class / IUCN category if known */
  protectClass: z.string().optional(),
  /** Local designation text, e.g. 'Chráněná krajinná oblast' */
  designation: z.string().optional(),
  /** Zone of a national park / CHKO if known (e.g. 'I', 'II') */
  zone: z.string().optional(),
  osmRef: z.string().optional(),
  countryCode: CountryCodeSchema.optional(),
});
export type ProtectedAreaInfo = z.infer<typeof ProtectedAreaInfoSchema>;

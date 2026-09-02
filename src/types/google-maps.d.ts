// Makes the global `google.maps` namespace visible to the type checker.
// The types come from the @types/google.maps package (already installed);
// without this reference, EquipmentMap.tsx and FreightMap.tsx fail typecheck
// with "Cannot find name 'google'". Do not delete.
/// <reference types="google.maps" />

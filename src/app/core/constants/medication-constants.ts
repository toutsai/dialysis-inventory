// src/app/core/constants/medication-constants.ts

export interface MedDef {
  code: string;
  tradeName: string;
  type: string;
  unit: string;
}

export interface MedicationGroup {
  title: string;
  meds: MedDef[];
}

// 此列表複製自 LabMedCorrelationView 以確保一致性
export const CORRELATION_GROUPS: MedicationGroup[] = [
  {
    title: '貧血管理 (Anemia)',
    meds: [
      { code: 'INES2', tradeName: 'NESP', type: 'injection', unit: 'mcg' },
      { code: 'IREC1', tradeName: 'Recormon', type: 'injection', unit: 'KIU' },
      { code: 'OVAF', tradeName: 'Vafseo', type: 'oral', unit: '顆' },
      { code: 'IFER2', tradeName: 'Fe-back', type: 'injection', unit: 'mg' },
    ],
  },
  {
    title: '鈣磷代謝 (Mineral Metabolism)',
    meds: [
      { code: 'OCAL1', tradeName: 'A-Cal', type: 'oral', unit: '顆' },
      { code: 'OCAA', tradeName: 'Pro-Ca', type: 'oral', unit: '顆' },
      { code: 'OFOS4', tradeName: 'Lanclean', type: 'oral', unit: '顆' },
      { code: 'OALK1', tradeName: 'Alkantin', type: 'oral', unit: '顆' },
      { code: 'ICAC', tradeName: 'Cacare', type: 'injection', unit: 'amp' },
      { code: 'OUCA1', tradeName: 'U-Ca', type: 'oral', unit: '顆' },
      { code: 'IPAR1', tradeName: 'Parsabiv', type: 'injection', unit: 'mg' },
      { code: 'OORK', tradeName: 'Orkedia', type: 'oral', unit: '顆' },
    ],
  },
];

// 扁平化的所有藥物列表
export const ALL_MEDS_MASTER: MedDef[] = CORRELATION_GROUPS.flatMap((g) => g.meds);

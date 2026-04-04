// src/utils/medicationUtils.js

const MEDICATION_UNITS_MAP = {
  INES2: 'mcg',
  IREC1: 'KIU',
  IFER2: 'mg',
  ICAC: 'mcg',
  IPAR1: 'mg',
  // ... 其他您知道單位的藥物
}

/**
 * 根據醫囑的 Code 或 Name 獲取其單位
 * @param {object} order - 醫囑物件，應包含 orderCode 和 orderName
 * @returns {string} - 藥物單位字串，或空字串
 */
export function getMedicationUnit(order) {
  if (!order) return ''

  const { orderCode, orderName } = order

  if (orderCode && MEDICATION_UNITS_MAP[orderCode]) {
    return MEDICATION_UNITS_MAP[orderCode]
  }

  if (orderName) {
    for (const key in MEDICATION_UNITS_MAP) {
      if (orderName.includes(key)) {
        return MEDICATION_UNITS_MAP[key]
      }
    }
  }

  return ''
}

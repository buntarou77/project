import type { Hall, Service } from '@/core/types'

// Услуги аренды, доступные конкретному залу (белый список услуги).
// «Без специалиста» — первыми: это основной вариант аренды.
export function rentalServicesForHall(services: Service[], hall: Hall, rentalEnabled = true): Service[] {
  // C7: выключенная аренда скрывает кнопки везде, где эта функция используется
  if (!rentalEnabled) return []
  return services
    .filter((svc) => svc.kind === 'rental' && (!svc.hallIds?.length || svc.hallIds.includes(hall.id)))
    .sort(
      (a, b) =>
        Number(a.needsSpecialist) - Number(b.needsSpecialist) ||
        Number(b.defaultHallId === hall.id) - Number(a.defaultHallId === hall.id) ||
        a.sort - b.sort
    )
}

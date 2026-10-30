import type { ChipTone } from '../../shared/ui';
import type { BlockingReason, Event, EventStatus, Registration } from './eventsApi';

export const statuses: Record<EventStatus, { label: string; tone: ChipTone }> = {
  draft: { label: 'Черновик', tone: 'dashed' },
  open: { label: 'Запись открыта', tone: 'lime' },
  closed: { label: 'Запись закрыта', tone: 'sun' },
  in_progress: { label: 'Идёт', tone: 'pink' },
  completed: { label: 'Завершено', tone: 'ink' },
  cancelled: { label: 'Отменено', tone: 'sand' },
};

export type Target = Exclude<EventStatus, 'draft'>;

/** Allowed transitions, as the server checks them; the order is the order of buttons. */
export const transitions: Record<EventStatus, Target[]> = {
  draft: ['open', 'cancelled'],
  open: ['closed', 'cancelled'],
  closed: ['in_progress', 'open', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const transitionLabels: Record<Target, string> = {
  open: 'Открыть запись на мероприятие',
  closed: 'Закрыть запись',
  in_progress: 'Начать мероприятие',
  completed: 'Завершить',
  cancelled: 'Отменить мероприятие',
};

export const audiences: Record<NonNullable<Event['audience']>, string> = {
  dogs: 'Собаки',
  people: 'Люди',
  mixed: 'Собаки и люди',
};

export const registrationStatuses: Record<Registration['status'], { label: string; tone: ChipTone }> = {
  registered: { label: 'Записан', tone: 'sand' },
  attended: { label: 'Участвовал', tone: 'lime' },
  cancelled: { label: 'Запись отменена', tone: 'dashed' },
};

export const qualifications: Record<Registration['qualification'], { label: string; tone: ChipTone }> = {
  pending: { label: 'Ждёт эксперта', tone: 'sun' },
  approved: { label: 'Квалификация подтверждена', tone: 'lime' },
  rejected: { label: 'Квалификация отклонена', tone: 'pink' },
};

export const blockingReasons: Record<BlockingReason, string> = {
  event_unconfigured: 'Мероприятие не настроено: нет периода, часового пояса или аудитории',
  schedule_missing: 'Не выбрано время выступления',
  schedule_disabled: 'Время выступления выключено',
  schedule_outside_event: 'Выступление выходит за период мероприятия',
  schedule_class_mismatch: 'Время выступления относится к другому классу',
  event_cancelled: 'Мероприятие отменено',
  event_draft: 'Мероприятие ещё в черновике',
  registration_cancelled: 'Запись отменена',
  dog_required: 'Для мероприятия нужна собака',
  people_only: 'Мероприятие только для людей',
  dog_inactive: 'Собака не на учёте',
  pedigree_incomplete: 'Родословная не известна на три поколения',
  identifier_missing: 'У собаки нет идентификатора',
  representative_not_owner: 'Представитель не владелец собаки',
  class_required: 'Нужно выбрать класс',
  classes_not_used: 'Мероприятие проходит без классов',
  class_missing: 'Класс не найден',
  class_disabled: 'Класс выключен',
  age_not_allowed: 'Возраст собаки не подходит классу',
  medical_clearance: 'Нет медицинского допуска к мероприятиям на весь период',
  qualification_required: 'Нужно решение эксперта по квалификации',
};

/** History actions per entity, as the server writes them. */
export const historyActions: Record<string, string> = {
  'venue:created': 'Площадка создана',
  'venue:corrected': 'Площадка исправлена',
  'event:created': 'Мероприятие создано',
  'event:corrected': 'Мероприятие исправлено',
  'event:state_changed': 'Изменено состояние',
  'event:experts_changed': 'Изменены эксперты',
  'class:saved': 'Сохранён класс',
  'schedule:saved': 'Сохранено время выступления',
  'registration:created': 'Участник записан',
  'registration:corrected': 'Запись исправлена',
  'registration:cancelled': 'Запись отменена',
  'registration:attended': 'Отмечена явка',
  'registration:qualification_decided': 'Эксперт решил по квалификации',
  'registration:result_recorded': 'Внесён результат',
  'result:created': 'Результат внесён',
  'result:corrected': 'Результат исправлен',
  'result:voided': 'Результат отмечен ошибочным',
};

/** "от 6 до 15 мес.", "с 9 мес.", "до 12 мес." or empty. */
export function ageRange(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `от ${min} до ${max} мес.`;
  if (min !== null) return `с ${min} мес.`;
  if (max !== null) return `до ${max} мес.`;
  return '';
}

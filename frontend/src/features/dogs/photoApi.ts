import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, call } from '../../api/client';
import { fetchBlob, postForm } from '../../api/files';
import { ApiError } from '../../api/problem';
import type { components } from '../../api/schema';

export type DogPhoto = components['schemas']['DogPhoto'];

export const photoKeys = {
  all: ['dog-photo'] as const,
  photo: (dogID: number) => ['dog-photo', dogID] as const,
};

/** Photos the API accepts; the server checks the bytes again. */
export const photoTypes = ['image/jpeg', 'image/png'];
export const MAX_PHOTO = 5 * 1024 * 1024;

export function photoProblem(file: File | null): string | undefined {
  if (!file) return undefined;
  if (!photoTypes.includes(file.type)) return 'Подойдёт JPEG или PNG.';
  if (file.size > MAX_PHOTO) return 'Фото больше 5 МБ.';
  if (file.size === 0) return 'Файл пустой.';
  return undefined;
}

export interface LoadedPhoto {
  meta: DogPhoto;
  blob: Blob;
}

/**
 * The photo of a dog, or null when it has none. Images need the bearer token, so
 * the bytes are fetched here and shown through an object URL, not a plain src.
 */
export function useDogPhoto(dogID: number) {
  return useQuery({
    queryKey: photoKeys.photo(dogID),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<LoadedPhoto | null> => {
      let meta: DogPhoto;
      try {
        meta = await call(api.GET('/api/v1/dogs/{dogID}/photo', { params: { path: { dogID } } }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
      return { meta, blob: await fetchBlob(`/api/v1/dogs/${dogID}/photo/file`) };
    },
  });
}

export function usePhotoSaved() {
  const client = useQueryClient();
  return (dogID: number) => client.invalidateQueries({ queryKey: photoKeys.photo(dogID) });
}

export const photoApi = {
  set: (dogID: number, file: File, version: number) => {
    const form = new FormData();
    form.append('version', String(version));
    form.append('file', file, file.name);
    return postForm<DogPhoto>(`/api/v1/dogs/${dogID}/photo`, form, 'PUT');
  },
  remove: (dogID: number, version: number, reason: string) => call(api.DELETE('/api/v1/dogs/{dogID}/photo', { params: { path: { dogID } }, body: { version, reason } })),
};

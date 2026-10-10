import { Prisma } from '@prisma/client';
import prisma from './database';
import { invalidateAliasCache, invalidateDomainsCache } from './redis';
import logger from '../utils/logger';

const BATCH_SIZE = 500;

/**
 * Delete all aliases matching `where`, keeping Domain.aliasCount in sync and
 * invalidating the mail-path alias cache for every deleted address.
 *
 * Returns the number of aliases deleted.
 */
export async function deleteAliasesWhere(where: Prisma.AliasWhereInput): Promise<number> {
  let deleted = 0;

  // Process in batches so a large backlog doesn't load everything at once
  for (;;) {
    const batch = await prisma.alias.findMany({
      where,
      select: { id: true, fullAddress: true, domainId: true },
      take: BATCH_SIZE,
    });
    if (batch.length === 0) break;

    const result = await prisma.alias.deleteMany({
      where: { id: { in: batch.map((a) => a.id) } },
    });
    deleted += result.count;
    if (result.count === 0) break;

    const perDomain = new Map<string, number>();
    for (const alias of batch) {
      perDomain.set(alias.domainId, (perDomain.get(alias.domainId) || 0) + 1);
    }
    for (const [domainId, count] of perDomain) {
      try {
        await prisma.domain.update({
          where: { id: domainId },
          data: { aliasCount: { decrement: count } },
        });
      } catch (error) {
        logger.error('Failed to decrement domain alias count:', error);
      }
    }

    await Promise.all(batch.map((a) => invalidateAliasCache(a.fullAddress)));

    if (batch.length < BATCH_SIZE) break;
  }

  if (deleted > 0) {
    await invalidateDomainsCache();
  }

  return deleted;
}

/**
 * Invalidate the mail-path cache for every alias owned by a user
 * (e.g. after the user is deactivated).
 */
export async function invalidateUserAliasCaches(userId: string): Promise<void> {
  const aliases = await prisma.alias.findMany({
    where: { userId },
    select: { fullAddress: true },
  });
  await Promise.all(aliases.map((a) => invalidateAliasCache(a.fullAddress)));
}

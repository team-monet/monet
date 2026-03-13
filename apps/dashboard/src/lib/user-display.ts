type UserDisplayInput = {
  displayName?: string | null;
  email?: string | null;
  externalId?: string | null;
};

function normalized(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getUserPrimaryLabel(user: UserDisplayInput) {
  return (
    normalized(user.displayName) ??
    normalized(user.email) ??
    normalized(user.externalId) ??
    "Unknown user"
  );
}

export function getUserSecondaryLabel(user: UserDisplayInput) {
  const primary = getUserPrimaryLabel(user);
  const email = normalized(user.email);
  const externalId = normalized(user.externalId);

  if (email && email !== primary) {
    return email;
  }

  if (externalId && externalId !== primary) {
    return externalId;
  }

  return null;
}

export function getUserOptionLabel(user: UserDisplayInput) {
  const primary = getUserPrimaryLabel(user);
  const secondary = getUserSecondaryLabel(user);
  return secondary ? `${primary} · ${secondary}` : primary;
}

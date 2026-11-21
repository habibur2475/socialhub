'use client';

/**
 * Profile editing form.
 *
 * Validation uses `updateProfileRequestSchema` from `@socialhub/contracts` — the
 * same object the API runs. That is why there is no character-count constant in
 * this file: the limit is the schema's, and a copy of `500` here would eventually
 * disagree with it.
 *
 * Visibility is a radio group, not a select. There are three options with
 * materially different consequences, and each needs a sentence of explanation; a
 * dropdown would hide that explanation behind a click and default the user into a
 * choice they did not read.
 */

import { useEffect, useState } from 'react';
import { updateProfileRequestSchema, type ProfileResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { Field, FormError, FormNotice, Input } from '@/components/ui/field';
import { fieldsFromApi, fieldsFromZod, describeError, useSubmitState } from '@/lib/form';
import { isApiFailure } from '@/lib/api-client';
import { createProfileApi } from '@/lib/profile-api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';

export type ProfileFormProps = {
  readonly profile: ProfileResponse;
  /** Hands the persisted profile back so the header and the form stay in step. */
  readonly onSaved: (profile: ProfileResponse) => void;
};

const VISIBILITY_OPTIONS = [
  {
    value: 'PUBLIC',
    label: 'Public',
    description: 'Anyone signed in can see your profile and posts.',
  },
  {
    value: 'FOLLOWERS',
    label: 'Followers only',
    description: 'Only people you have accepted as followers see your posts.',
  },
  {
    value: 'PRIVATE',
    label: 'Private',
    description: 'Nobody sees your posts. New followers need your approval.',
  },
] as const;

type Visibility = (typeof VISIBILITY_OPTIONS)[number]['value'];

export const ProfileForm = ({ profile, onSaved }: ProfileFormProps): React.JSX.Element => {
  const { client } = useSession();
  const { state, start, fail, succeed } = useSubmitState();

  const [displayName, setDisplayName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio ?? '');
  const [visibility, setVisibility] = useState<Visibility>('PUBLIC');
  const [saved, setSaved] = useState(false);

  // The form starts from the server's values, so a failed save leaves the user's
  // edits in place rather than resetting them to the last fetched profile.
  useEffect(() => {
    setDisplayName(profile.displayName);
    setBio(profile.bio ?? '');
  }, [profile]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSaved(false);

    const candidate = { displayName, bio, visibility };
    const parsed = updateProfileRequestSchema.safeParse(candidate);

    if (!parsed.success) {
      start();
      fail({ fields: fieldsFromZod(parsed.error) });
      return;
    }

    start();

    try {
      const updated = await createProfileApi(client).update(parsed.data);
      succeed();
      setSaved(true);
      // The server's response is the source of truth, not the local draft: it
      // reflects trimming, normalisation and anything the API adjusted.
      onSaved(updated);
    } catch (cause) {
      if (isApiFailure(cause)) {
        const mapped = fieldsFromApi(cause);
        fail({ fields: mapped.fields, form: mapped.form });
        return;
      }
      fail({ form: describeError(cause) });
    }
  };

  return (
    <form
      className="flex max-w-[640px] flex-col gap-lg"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {state.formError === null ? null : <FormError>{state.formError}</FormError>}
      {saved ? <FormNotice>Your profile has been saved.</FormNotice> : null}

      <Field label="Display name" htmlFor="display-name" error={state.fieldErrors['displayName']}>
        <Input
          id="display-name"
          name="displayName"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          autoComplete="name"
          aria-invalid={state.fieldErrors['displayName'] === undefined ? undefined : true}
        />
      </Field>

      <Field
        label="Bio"
        htmlFor="bio"
        hint="Up to 500 characters. Shown according to your visibility setting."
        error={state.fieldErrors['bio']}
      >
        <textarea
          id="bio"
          name="bio"
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          rows={4}
          className={cn(
            'w-full resize-y rounded-md border border-border bg-surface px-sm py-xs',
            'text-body text-text placeholder:text-text-muted',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
          )}
        />
      </Field>

      <fieldset className="flex flex-col gap-sm">
        <legend className="mb-xs text-small font-medium text-text">Profile visibility</legend>
        {VISIBILITY_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer items-start gap-sm rounded-md border p-sm',
              visibility === option.value
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-surface-raised',
            )}
          >
            <input
              type="radio"
              name="visibility"
              value={option.value}
              checked={visibility === option.value}
              onChange={() => setVisibility(option.value)}
              className="mt-[3px]"
            />
            <span className="flex flex-col gap-[2px]">
              <span className="text-small font-medium text-text">{option.label}</span>
              <span className="text-caption text-text-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div>
        <button type="submit" className={buttonClass('primary', 'md')} disabled={state.submitting}>
          {state.submitting ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
};

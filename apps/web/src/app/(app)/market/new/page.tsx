/** Selling something: the create form. */

import { ListingEditor } from '@/components/market/listing-editor';

export const metadata = { title: 'Sell an item — SocialHub Market' };

export default function NewListingPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[640px]">
      <ListingEditor />
    </div>
  );
}

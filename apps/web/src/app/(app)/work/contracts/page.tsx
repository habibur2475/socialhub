/** Every contract the viewer is party to, from either side. */

import { ContractList } from '@/components/work/contract-list';

export const metadata = { title: 'Contracts — SocialHub Work' };

export default function ContractsPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <h1 className="text-heading">Contracts</h1>
        <p className="max-w-[60ch] text-body text-muted">
          Money already paid, held in escrow, released milestone by milestone when the work is
          approved. A dispute freezes it until support resolves it.
        </p>
      </header>

      <ContractList />
    </div>
  );
}

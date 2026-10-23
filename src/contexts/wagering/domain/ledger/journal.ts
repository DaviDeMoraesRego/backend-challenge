import { JournalCompositionError } from '../errors/domain-errors';
import type { WalletLegDraft } from '../wallet/wallet';
import type { CounterpartyLegDraft } from './counterparty-leg-draft';

export interface CreateJournalProps {
  readonly id: string;
  readonly transactionId: string;
  readonly createdAt: Date;
  /** perna do wallet: carrega saldo antes/depois e a versão consumida. */
  readonly walletLeg: WalletLegDraft;
  /** perna de contrapartida: nunca toca saldo de wallet. */
  readonly counterpartyLeg: CounterpartyLegDraft;
}

/**
 * Agrupamento da partida dobrada: exatamente 2 pernas opostas, de mesmo valor e
 * mesma moeda. A invariante é verificada **aqui** — o constraint trigger do
 * banco é a segunda linha de defesa, não a primeira.
 */
export class Journal {
  private constructor(
    public readonly id: string,
    public readonly transactionId: string,
    public readonly currency: string,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateJournalProps): Journal {
    const { walletLeg, counterpartyLeg } = props;
    if (!walletLeg || !counterpartyLeg) {
      throw new JournalCompositionError('journal exige exatamente 2 pernas');
    }
    if (walletLeg.amount.currency !== counterpartyLeg.amount.currency) {
      throw new JournalCompositionError('pernas em moedas diferentes');
    }
    if (!walletLeg.amount.equals(counterpartyLeg.amount)) {
      throw new JournalCompositionError('pernas com valores diferentes');
    }
    if (walletLeg.direction === counterpartyLeg.direction) {
      throw new JournalCompositionError(
        'pernas com a mesma direção — não há partida dobrada',
      );
    }
    return new Journal(
      props.id,
      props.transactionId,
      walletLeg.amount.currency,
      props.createdAt,
    );
  }
}

import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';

export class ApproveSignalUseCase {
  constructor(private readonly signalRepo: ISignalRepository) {}

  async execute(id: string): Promise<void> {
    await this.signalRepo.approve(id);
  }
}

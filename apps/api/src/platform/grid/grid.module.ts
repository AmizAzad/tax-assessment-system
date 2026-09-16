import { Global, Module } from '@nestjs/common';
import { GridController } from './grid.controller';
import { GridService } from './grid.service';

/**
 * Configurable registers.
 *
 * Global, because the domain modules that own registers have to reach the
 * registry at boot to publish them, and the export machinery has to reach it
 * to read them back.
 */
@Global()
@Module({
  controllers: [GridController],
  providers: [GridService],
  exports: [GridService],
})
export class GridModule {}

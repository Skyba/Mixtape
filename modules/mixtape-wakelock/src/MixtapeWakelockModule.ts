import { NativeModule, requireNativeModule } from 'expo';

declare class MixtapeWakelockModule extends NativeModule<{}> {}

export default requireNativeModule<MixtapeWakelockModule>('MixtapeWakelock');

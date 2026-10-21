const prohibited = (control) =>
  control.digitalRecordingControlData === 3 ||
  (control.digitalRecordingControlData === 1 && control.copyControlType === 1);
const blocksRecording = (descriptors = []) =>
  descriptors.some(
    (descriptor) =>
      descriptor.tag === 'digitalCopyControl' &&
      (prohibited(descriptor) || descriptor.componentControls?.some(prohibited)),
  );

// Only control the UI, using the selected service's received detail snapshot.
export function isRecordingProhibited(information) {
  if (!information) return false;
  const service = information.sdt?.services.find(
    (service) => service.serviceId === information.serviceId,
  );
  const event = information.events?.find((section) => section.sectionNumber === 0)?.events[0];
  return Boolean(
    blocksRecording(information.pmt?.programInfo) ||
      information.pmt?.streams.some((stream) => blocksRecording(stream.esInfo)) ||
      blocksRecording(service?.descriptors) ||
      blocksRecording(event?.descriptors),
  );
}
